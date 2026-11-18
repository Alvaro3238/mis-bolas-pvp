// Marble Fights · servidor en línea (PVP + cuentas con guardado en la nube)
// Empareja jugadores, crea salas y reenvía la sincronización del combate.
// Cuentas: si está puesta DATABASE_URL (p. ej. Neon), guarda usuario, contraseña (cifrada) y la partida de cada jugador.
// El "anfitrión" (host) de cada sala calcula el combate y manda instantáneas al "invitado" (guest).
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
// Baneos y versión mínima (se cambian en Render → Environment, sin tocar el código):
//   BANNED      = IDs de jugador, apodos o usuarios de cuenta separados por comas: baneo indefinido sin motivo
//                 (lo normal ahora es banear desde la página /admin, con motivo y duración)
//   ADMIN_KEY   = contraseña de la página de baneos: https://…onrender.com/admin
//   NAME_BAN_HOURS = horas de baneo automático por apodo inapropiado (por defecto 24; 0 = indefinido)
//   KEEP_AWAKE  = 0 para que el servidor NO se llame a sí mismo cada 10 minutos (por defecto sí, para que Render gratis no se duerma)
//   MIN_VERSION = versión mínima para jugar en línea, p. ej. "v267" (vacío = cualquiera)
const BANNED = new Set(String(process.env.BANNED || '').toUpperCase().split(/[\s,;]+/).filter(Boolean));   // IDs y apodos, en mayúsculas
/* Baneos con motivo y duración: objetivo (ID MF-…, apodo o usuario, en mayúsculas) → { until: ms (0 = indefinido), reason, by, at } */
const bans = new Map();
for (const t of BANNED) bans.set(t, { until: 0, reason: '', by: 'BANNED', at: 0 });
const banSeen = new Map();   // ID → baneo, para los IDs vistos con un apodo o cuenta baneados (siguen baneados aunque cambien de apodo)
const banLive = b => b && (!b.until || b.until > Date.now());
function banInfo(dev, name, user) {
  dev = String(dev || '').toUpperCase(); name = String(name || '').trim().toUpperCase(); user = String(user || '').trim().toUpperCase();
  let b = null;
  for (const k of [dev, user, name !== 'JUGADOR' ? name : '']) { if (k && banLive(bans.get(k))) { b = bans.get(k); break; } }
  if (!b && dev && banLive(banSeen.get(dev))) b = banSeen.get(dev);
  if (b && dev && !bans.has(dev)) banSeen.set(dev, b);
  return b; }
const isBanned = (dev, name, user) => !!banInfo(dev, name, user);
const banOut = b => b ? { until: b.until || 0, reason: b.reason || '' } : null;
async function banAdd(target, hours, reason, by) {
  target = String(target || '').trim().toUpperCase().slice(0, 40); if (!target) return null;
  const b = { until: hours > 0 ? Date.now() + hours * 3600e3 : 0, reason: String(reason || '').slice(0, 120), by: by || 'admin', at: Date.now() };
  bans.set(target, b); for (const [d, x] of banSeen) if (x === b || !banLive(x)) banSeen.delete(d);
  console.log(`BANEO · ${target} · ${b.until ? hours + ' h' : 'indefinido'} · motivo: ${b.reason || '—'} · por: ${b.by}`);
  if (typeof dbReady !== 'undefined' && dbReady) q(`insert into bans (target, reason, until, by_who) values ($1, $2, $3, $4) on conflict (target) do update set reason = $2, until = $3, by_who = $4, created = now()`, [target, b.reason, b.until, b.by]).catch(e => console.error('bans', e.message));
  return b; }
async function banDel(target) {
  target = String(target || '').trim().toUpperCase(); const b = bans.get(target); bans.delete(target);
  for (const [d, x] of banSeen) if (x === b) banSeen.delete(d);
  console.log(`DESBANEO · ${target}`);
  if (typeof dbReady !== 'undefined' && dbReady) q('delete from bans where target = $1', [target]).catch(() => {}); }
const NAME_BAN_HOURS = process.env.NAME_BAN_HOURS != null && process.env.NAME_BAN_HOURS !== '' ? Number(process.env.NAME_BAN_HOURS) : 24;
/* apodos y usuarios inapropiados (la misma lista y la misma función en el juego y en el servidor) */
const MF_BAD={sub:["hijodeputa", "hijoputa", "puta", "gilipoll", "maricon", "mariquit", "subnormal", "retrasad", "mongol", "follar", "follad", "folla", "polla", "vagina", "conyo", "konyo", "zorra", "cabron", "joder", "jodete", "mierda", "ojete", "nazi", "hitler", "heil", "negrata", "sudaca", "nigger", "nigga", "niga", "fuck", "fuk", "shit", "bitch", "cunt", "dick", "pussy", "whore", "slut", "faggot", "violad", "violar", "pedofil", "porno", "porn", "sexo", "sexy", "xxx", "semen", "esperma", "tetas", "chupamel", "chupala", "mamada", "mamon", "cipote", "verga", "pinga", "chocho", "cagon", "culero", "travelo", "bollera", "perra", "malparid", "gonorrea", "hijueput", "pendej", "mamaguev", "cojon", "orgasm", "masturb", "pajer", "kkk", "terroris", "suicid", "matate"],exact:["puto", "culo", "fag", "ass", "caca", "pis", "coño", "cono", "pedo", "teta", "tits", "sex", "hdp", "ptm", "ctm", "csm", "mrd", "wtf", "anal", "paja", "pene", "cock", "rape", "polla"]};
const MF_BAD_OK=['computa','disputa','diputad','reputa','imputa','amputa','shitake','dickens','nazir','mongolia','scunthorpe','analis','canal'];
function mfBadName(s){ let t=String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  t=t.replace(/[0]/g,'o').replace(/[1!|]/g,'i').replace(/3/g,'e').replace(/[4@]/g,'a').replace(/[5$]/g,'s').replace(/7/g,'t').replace(/8/g,'b').replace(/[^a-z]/g,'');
  for(const ok of MF_BAD_OK) t=t.split(ok).join('·');   /* palabras normales que contienen otra mala (computadora, disputa…) */
  if(!t.replace(/·/g,'')) return false;
  const vs=[t, t.replace(/v/g,'u')], dbl=w=>/(.)\1/.test(w);
  for(const v of vs){ const t2=v.replace(/(.)\1{2,}/g,'$1$1'), t1=v.replace(/(.)\1+/g,'$1');
    for(const w0 of MF_BAD.sub){ const w=w0.normalize('NFD').replace(/[\u0300-\u036f]/g,''); if(v.includes(w) || t2.includes(w) || (!dbl(w) && t1.includes(w))) return true; }
    for(const w0 of MF_BAD.exact){ const w=w0.normalize('NFD').replace(/[\u0300-\u036f]/g,''); if(v===w || t2===w || (!dbl(w) && t1===w)) return true; } }
  return false; }

/* apodo inapropiado: se banea el dispositivo (y su cuenta, si la tiene) */
async function banBadName(dev, name) { const acct = devAcct.get(dev); let b = null;
  if (dev) b = await banAdd(dev, NAME_BAN_HOURS, 'Nombre inapropiado', 'auto: «' + name + '»');
  if (acct) { const u = (await q('select username from accounts where id = $1', [acct]).catch(() => []))[0]; if (u) await banAdd(u.username, NAME_BAN_HOURS, 'Nombre inapropiado', 'auto: «' + name + '»'); }
  return b; }
const verNum = v => { const m = /^v?(\d+)$/i.exec(String(v || '').trim()); return m ? Number(m[1]) : 0; };
const MIN_VERSION = verNum(process.env.MIN_VERSION);
const bannedNames = new Set();   // apodos usados por IDs baneados: no salen en la clasificación
const ARENAS = ['clasica', 'pilares', 'electrica', 'hielo', 'portales', 'pinball'];
const MAX_MATCH_MS = 4 * 60 * 1000;      // una sala no dura más de 4 minutos
const clients = new Set();
let queue = [];                            // jugadores buscando rival
let nextId = 1, nextRoom = 1, matchesPlayed = 0;
// Clasificación: última puntuación conocida de cada apodo (en memoria: se borra si el servidor se reinicia)
const board = new Map();
function record(l) {
  if (!l || !l.name || l.name === 'Jugador' || bannedNames.has(l.name.toLowerCase())) return;
  const key = l.name.toLowerCase(), old = board.get(key);  // se guarda la puntuación más reciente de cada apodo
  board.set(key, { name: l.name, trophies: l.trophies, ball: l.id, at: old && old.trophies === l.trophies ? old.at : Date.now() });
  if (board.size > 5000) { const worst = [...board.entries()].sort((a, b) => a[1].trophies - b[1].trophies)[0]; board.delete(worst[0]); }
}
/* ================= Cuentas y guardado en la nube =================
   Sin DATABASE_URL el servidor funciona igual que antes (solo PVP) y las cuentas responden «nodb». */
let pool = null, dbReady = false;
const makePool = ssl => { const { Pool } = require('pg'); const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: ssl ? { rejectUnauthorized: false } : false, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 }); p.on('error', e => console.error('pg', e.message)); return p; };
let pgSsl = process.env.PGSSL === '0' ? false : process.env.PGSSL === '1' ? true : !/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');
if (process.env.DATABASE_URL) { try { pool = makePool(pgSsl); } catch (e) { console.error('No se pudo cargar pg:', e.message); pool = null; } }
const q = (sql, params) => pool.query(sql, params).then(r => r.rows);
async function dbInit() {
  if (!pool) return;
  try { await q('select 1'); }
  catch (e) { if (pgSsl && process.env.PGSSL !== '1' && /SSL/i.test(e.message)) { try { await pool.end(); } catch (_) {} pgSsl = false; pool = makePool(false); await q('select 1'); } else throw e; }
  await q(`create table if not exists accounts (
    id text primary key, user_lc text unique not null, username text not null, passhash text not null,
    save text, save_at bigint not null default 0, prev_save text, prev_at bigint not null default 0,
    last_dev text not null default '', created timestamptz not null default now(), seen timestamptz not null default now())`);
  await q(`create table if not exists sessions (
    tokhash text primary key, acct text not null references accounts(id) on delete cascade,
    dev text not null default '', created timestamptz not null default now(), seen timestamptz not null default now())`);
  await q(`create index if not exists sessions_acct on sessions (acct)`);
  await q(`create table if not exists names (name_lc text primary key, name text not null, owner text not null, updated timestamptz not null default now())`);
  await q(`create index if not exists names_owner on names (owner)`);
  await q(`create table if not exists bans (target text primary key, reason text not null default '', until bigint not null default 0, by_who text not null default '', created timestamptz not null default now())`);
  for (const r of await q('select target, reason, until, by_who from bans')) bans.set(r.target, { until: Number(r.until) || 0, reason: r.reason, by: r.by_who, at: 0 });
  for (const r of await q('select name_lc, owner from names')) nameOwner.set(r.name_lc, r.owner);
  for (const r of await q(`select dev, acct from sessions where dev <> ''`)) devAcct.set(r.dev, r.acct);
  dbReady = true; console.log('Base de datos lista (cuentas)');
}
function dbStart(n = 0) { if (!pool) return; dbInit().catch(e => { console.error('Base de datos:', e.message); if (n < 20) setTimeout(() => dbStart(n + 1), Math.min(60000, 3000 * (n + 1))); }); }
dbStart();
/* Apodos únicos: cada apodo pertenece a una cuenta (si tiene) o a un dispositivo (su ID MF-…) */
const nameOwner = new Map(), devAcct = new Map();
const cleanName = v => String(v || '').replace(/[<>&"]/g, '').trim().slice(0, 10);
const nameMine = (lc, dev) => { const o = nameOwner.get(lc); return !o || o === dev || (devAcct.get(dev) && o === devAcct.get(dev)); };
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const hashPass = pass => new Promise((ok, ko) => { const salt = crypto.randomBytes(16); crypto.scrypt(pass, salt, 32, SCRYPT, (e, k) => e ? ko(e) : ok('s1$' + salt.toString('hex') + '$' + k.toString('hex'))); });
const checkPass = (pass, stored) => new Promise(ok => { try { const [, salt, key] = String(stored).split('$'); crypto.scrypt(pass, Buffer.from(salt, 'hex'), 32, SCRYPT, (e, k) => ok(!e && crypto.timingSafeEqual(k, Buffer.from(key, 'hex')))); } catch (e) { ok(false); } });
const USER_RE = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚüÜ.-]{3,16}$/;
const MAX_SAVE = 300 * 1024;
// Frenos: por IP, cuentas nuevas por hora e intentos de entrar por minuto; por usuario, 10 contraseñas mal seguidas → 15 min bloqueado
const rate = new Map();
const hit = (key, max, ms) => { const now = Date.now(); let r = rate.get(key); if (!r || now > r.until) { r = { n: 0, until: now + ms }; rate.set(key, r); } r.n++; if (rate.size > 20000) for (const [k, v] of rate) if (now > v.until) rate.delete(k); return r.n > max; };
const SIGNUP_LIMIT = Number(process.env.SIGNUP_LIMIT || 5);
async function newSession(acct, dev) { if (dev) devAcct.set(dev, acct); const tok = crypto.randomBytes(24).toString('base64url'); await q('insert into sessions (tokhash, acct, dev) values ($1, $2, $3)', [sha(tok), acct, dev]);
  await q(`delete from sessions where acct = $1 and tokhash not in (select tokhash from sessions where acct = $1 order by seen desc limit 10)`, [acct]); return tok; }
async function bySession(tok) { if (!tok || typeof tok !== 'string' || tok.length > 80) return null;
  const rows = await q('select a.id, a.username, a.save_at from sessions s join accounts a on a.id = s.acct where s.tokhash = $1', [sha(tok)]);
  if (!rows.length) return null; q('update sessions set seen = now() where tokhash = $1', [sha(tok)]).catch(() => {}); return rows[0]; }
const cleanSave = v => (typeof v === 'string' && v.length > 2 && v.length <= MAX_SAVE) ? v : null;
async function acctAction(a, body, ip) {
  const dev = String(body.dev || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  if (a === 'name') {   // reservar un apodo (o comprobar que es tuyo)
    const name = cleanName(body.name), lc = name.toLowerCase();
    if (name.length < 3 || lc === 'jugador') return { err: 'name' };
    if (!dev) return { err: 'what' };
    if (mfBadName(name)) { const b = await banBadName(dev, name); return { err: 'badname', ban: banOut(b) }; }
    if (hit('name:' + ip, 30, 60e3)) return { err: 'slow' };
    const A = body.token ? await bySession(body.token) : null, owner = A ? A.id : dev;
    if (A) devAcct.set(dev, A.id);
    const cur = (await q('select owner from names where name_lc = $1', [lc]))[0];
    if (cur && cur.owner !== owner && cur.owner !== dev && !(A && cur.owner === A.id)) return { err: 'taken' };
    await q(`delete from names where (owner = $1 or owner = $2) and name_lc <> $3`, [owner, dev, lc]);   // suelta el apodo anterior
    await q(`insert into names (name_lc, name, owner) values ($1, $2, $3) on conflict (name_lc) do update set name = $2, owner = $3, updated = now()`, [lc, name, owner]);
    for (const [k, o] of nameOwner) if ((o === owner || o === dev) && k !== lc) nameOwner.delete(k);
    nameOwner.set(lc, owner); return { ok: true, name };
  }
  if (a === 'register') {
    const user = String(body.user || '').trim(), pass = String(body.pass || '');
    if (!USER_RE.test(user)) return { err: 'user' };
    if (pass.length < 6 || pass.length > 72) return { err: 'pass' };
    if (mfBadName(user)) return { err: 'baduser' };
    if (hit('reg:' + ip, SIGNUP_LIMIT, 3600e3)) return { err: 'slow' };
    { const b = banInfo(dev, '', user); if (b) return { err: 'banned', ban: banOut(b) }; }
    const save = cleanSave(body.save), at = Date.now(), id = 'A' + crypto.randomBytes(8).toString('hex');
    try { await q('insert into accounts (id, user_lc, username, passhash, save, save_at, last_dev) values ($1, $2, $3, $4, $5, $6, $7)', [id, user.toLowerCase(), user, await hashPass(pass), save, save ? at : 0, dev]); }
    catch (e) { if (/unique|duplicate/i.test(e.message)) return { err: 'taken' }; throw e; }
    console.log(`cuenta nueva · ${user} · id=${dev || '?'}`);
    return { ok: true, user, token: await newSession(id, dev), at: save ? at : 0 };
  }
  if (a === 'login') {
    const user = String(body.user || '').trim(), pass = String(body.pass || '');
    if (hit('login:' + ip, 20, 60e3)) return { err: 'slow' };
    if (!user || !pass) return { err: 'bad' };
    const lockKey = 'fail:' + user.toLowerCase(); const lk = rate.get(lockKey); if (lk && lk.n >= 10 && Date.now() < lk.until) return { err: 'locked' };
    const rows = await q('select id, username, passhash, save, save_at from accounts where user_lc = $1', [user.toLowerCase()]);
    if (!rows.length || !(await checkPass(pass, rows[0].passhash))) { hit(lockKey, 10, 15 * 60e3); return { err: 'bad' }; }
    rate.delete(lockKey); const A = rows[0];
    { const b = banInfo(dev, '', A.username); if (b) return { err: 'banned', ban: banOut(b) }; }
    q('update accounts set seen = now(), last_dev = $2 where id = $1', [A.id, dev]).catch(() => {});
    console.log(`entrar · ${A.username} · id=${dev || '?'}`);
    return { ok: true, user: A.username, token: await newSession(A.id, dev), save: A.save || null, at: Number(A.save_at) || 0 };
  }
  const A = await bySession(body.token); if (!A) return { err: 'auth' };
  if (a === 'meta') { const b = banInfo(dev, '', A.username); if (b) return { ok: true, user: A.username, at: Number(A.save_at) || 0, banned: true, ban: banOut(b) }; return { ok: true, user: A.username, at: Number(A.save_at) || 0 }; }
  if (a === 'load') { const r = await q('select save, save_at from accounts where id = $1', [A.id]); return { ok: true, user: A.username, save: r[0].save || null, at: Number(r[0].save_at) || 0 }; }
  if (a === 'save') {
    const save = cleanSave(body.save); if (!save) return { err: 'big' };
    if (hit('save:' + A.id, 30, 60e3)) return { err: 'slow' };
    if (body.base != null && !body.force && Number(body.base) !== (Number(A.save_at) || 0)) return { err: 'conflict', at: Number(A.save_at) || 0 };   // otro dispositivo guardó después
    const at = Date.now();   // la copia anterior se guarda por si acaso (prev_save)
    await q('update accounts set prev_save = save, prev_at = save_at, save = $2, save_at = $3, seen = now(), last_dev = $4 where id = $1', [A.id, save, at, dev]);
    return { ok: true, at };
  }
  if (a === 'logout') { await q('delete from sessions where tokhash = $1', [sha(body.token)]); return { ok: true }; }
  if (a === 'pass') {
    const old = String(body.old || ''), nw = String(body.pass || ''); if (nw.length < 6 || nw.length > 72) return { err: 'pass' };
    const r = await q('select passhash from accounts where id = $1', [A.id]); if (!(await checkPass(old, r[0].passhash))) return { err: 'bad' };
    await q('update accounts set passhash = $2 where id = $1', [A.id, await hashPass(nw)]);
    await q('delete from sessions where acct = $1 and tokhash <> $2', [A.id, sha(body.token)]); return { ok: true };
  }
  return { err: 'what' };
}
function acctHttp(req, res) {
  const out = (code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (req.method === 'OPTIONS') return out(204, {});
  if (req.method !== 'POST') return out(405, { err: 'what' });
  if (!pool) return out(200, { err: 'nodb' });
  if (!dbReady) return out(200, { err: 'nodbyet' });
  const a = req.url.slice(6).split('?')[0];
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  let body = '', big = false;
  req.on('data', c => { if (big) return; body += c; if (body.length > MAX_SAVE + 4096) { big = true; body = ''; } });
  req.on('end', async () => { if (big) return out(413, { err: 'big' });
    let o; try { o = JSON.parse(body || '{}'); } catch (e) { return out(400, { err: 'what' }); }
    try { out(200, await acctAction(a, o || {}, ip)); } catch (e) { console.error('cuentas', a, e.message); out(200, { err: 'server' }); } });
}

const top3 = () => [...board.values()].sort((a, b) => b.trophies - a.trophies || a.at - b.at).slice(0, 3).map(({ name, trophies, ball }) => ({ name, trophies, ball }));

/* ================= Página de baneos: https://…onrender.com/admin (contraseña ADMIN_KEY) ================= */
const escH = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function adminPage(key, msg) {
  const now = Date.now(), list = [...bans.entries()].filter(([, b]) => banLive(b)).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const left = b => { if (!b.until) return 'Indefinido'; const s = Math.max(0, (b.until - now) / 1000 | 0), d = s / 86400 | 0, h = (s % 86400) / 3600 | 0, m = (s % 3600) / 60 | 0; return (d ? d + ' d ' : '') + h + ' h ' + m + ' min'; };
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baneos · Marble Fights</title>
<style>body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#16101a;color:#f3eaf0;padding:16px}h1{font-size:22px;margin:0 0 12px;color:#ffd54a}
.c{background:#2a1f27;border-radius:14px;padding:14px;margin-bottom:14px}label{display:block;font-size:13px;color:#c9b8c2;margin:8px 0 4px}
input,select{width:100%;box-sizing:border-box;height:44px;border-radius:10px;border:1.5px solid #4a3a44;background:#1a1216;color:#fff;padding:0 12px;font-size:16px}
button{height:44px;border:0;border-radius:10px;padding:0 16px;font-weight:700;font-size:15px;margin-top:12px;background:#e6b53a;color:#2b1f24}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid #3a2d36;padding:10px 0}.row:first-child{border-top:0}
.row b{display:block;word-break:break-all}.row small{color:#c9b8c2}.row form button{background:#5a1f2e;color:#ffc2c4;margin:0}.msg{color:#9fe3b0;margin-bottom:10px}.hint{color:#c9b8c2;font-size:13px}</style></head><body>
<h1>Baneos</h1>${msg ? `<div class="msg">${escH(msg)}</div>` : ''}
<form class="c" method="post" action="/admin"><input type="hidden" name="key" value="${escH(key)}"><input type="hidden" name="a" value="ban">
<label>A quién: ID (MF-…), apodo o usuario de cuenta</label><input name="target" required autocapitalize="off" spellcheck="false" placeholder="MF-9HBYUE8D">
<label>Duración</label><select name="hours"><option value="1">1 hora</option><option value="6">6 horas</option><option value="24" selected>24 horas</option><option value="72">3 días</option><option value="168">7 días</option><option value="720">30 días</option><option value="0">Indefinido</option></select>
<label>Motivo (lo verá el jugador)</label><input name="reason" maxlength="120" placeholder="Insultos, trampas…"><button>Banear</button>
<p class="hint">Los IDs y apodos salen en Render → Logs (líneas «abrir» y «buscar»).</p></form>
<div class="c"><b>Baneados ahora (${list.length})</b>${list.map(([t, b]) => `<div class="row"><div><b>${escH(t)}</b><small>${escH(b.reason || 'Sin motivo')} · ${left(b)}${b.by && b.by !== 'admin' ? ' · ' + escH(b.by) : ''}</small></div>${b.by === 'BANNED' ? '<small>en BANNED</small>' : `<form method="post" action="/admin"><input type="hidden" name="key" value="${escH(key)}"><input type="hidden" name="a" value="unban"><input type="hidden" name="target" value="${escH(t)}"><button>Quitar</button></form>`}</div>`).join('') || '<p class="hint">Nadie.</p>'}</div>
<p class="hint">${dbReady ? 'Los baneos se guardan en la base de datos.' : 'Sin base de datos: los baneos de esta página se pierden si el servidor se reinicia.'}</p></body></html>`; }
function adminHttp(req, res) {
  const html = (code, h) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }); res.end(h); };
  const KEY = process.env.ADMIN_KEY || '';
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const login = m => html(200, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baneos</title><style>body{margin:0;font:16px system-ui;background:#16101a;color:#fff;padding:24px}input{width:100%;box-sizing:border-box;height:46px;border-radius:10px;border:1.5px solid #4a3a44;background:#1a1216;color:#fff;padding:0 12px;font-size:16px}button{margin-top:12px;height:46px;width:100%;border:0;border-radius:10px;background:#e6b53a;font-weight:700;font-size:16px}p{color:#ff9a9a}</style></head><body><h2>Baneos · Marble Fights</h2>${m ? `<p>${escH(m)}</p>` : ''}<form method="post" action="/admin"><input type="hidden" name="a" value="list"><input type="password" name="key" placeholder="Contraseña (ADMIN_KEY)" autocomplete="current-password"><button>Entrar</button></form></body></html>`);
  if (!KEY) return html(200, '<meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px system-ui;padding:20px">La página de baneos está desactivada: pon la variable <b>ADMIN_KEY</b> en Render → Environment.</p>');
  if (req.method !== 'POST') return login('');
  let body = ''; req.on('data', c => { if (body.length < 4096) body += c; });
  req.on('end', async () => {
    const f = new URLSearchParams(body), key = f.get('key') || '';
    if (hit('admin:' + ip, 30, 60e3)) return login('Demasiados intentos. Espera un minuto.');
    if (key.length !== KEY.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(KEY))) { hit('adminbad:' + ip, 5, 15 * 60e3); return login('Contraseña incorrecta.'); }
    const a = f.get('a'); let msg = '';
    if (a === 'ban') { const t = f.get('target'), h = Number(f.get('hours')) || 0; const b = await banAdd(t, h, f.get('reason'), 'admin'); msg = b ? `Baneado: ${String(t).trim().toUpperCase()}` : 'Falta a quién banear.'; }
    if (a === 'unban') { await banDel(f.get('target')); msg = `Quitado: ${f.get('target')}`; }
    html(200, adminPage(key, msg)); }); }

const server = http.createServer((req, res) => {
  if (req.url === '/ping' || req.url.startsWith('/ping?')) { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end('ok'); return; }   // para mantenerlo despierto (no toca la base de datos)
  if (req.url && req.url.startsWith('/acct/')) return acctHttp(req, res);
  if (req.url && /^\/admin(\?|$|\/)/.test(req.url)) return adminHttp(req, res);
  if (req.url && req.url.startsWith('/ban')) {   // ¿este ID está baneado? (el juego lo pregunta al abrirse y al darle a jugar)
    let id = '', n = '', v = '', u = ''; try { const q = new URL(req.url, 'http://x').searchParams; id = String(q.get('id') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20); n = String(q.get('n') || '').slice(0, 24); v = String(q.get('v') || '').slice(0, 12); u = String(q.get('u') || '').slice(0, 20); } catch (e) {}
    const B = banInfo(id, n, u), b = !!B;
    if (id) console.log(`abrir · id=${id} · apodo=${n || '?'}${u ? ' · cuenta=' + u : ''} · versión=${v || '?'} · baneado=${b ? 'SÍ' : 'no'}`);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify(Object.assign({ banned: b }, b ? banOut(B) : {}))); return;
  }
  if (req.url && req.url.startsWith('/top')) {
    try { const q = new URL(req.url, 'http://x').searchParams; if (q.get('n') && !(dbReady && nameOwner.has(String(q.get('n')).trim().toLowerCase()))) record(cleanLoadout({ name: q.get('n'), trophies: q.get('t'), id: q.get('b') })); } catch (e) {}
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ top: top3(), players: board.size })); return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(`Mis Bolas PVP funcionando · conectados: ${clients.size} · buscando: ${queue.length} · combates: ${matchesPlayed} · baneados: ${[...bans.values()].filter(banLive).length} · versión mínima: ${MIN_VERSION ? 'v' + MIN_VERSION : 'ninguna'} · cuentas: ${dbReady ? 'sí' : pool ? 'base de datos sin conectar' : 'no (falta DATABASE_URL)'}\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const str = (v, max, def = '') => (typeof v === 'string' ? v.slice(0, max) : def);
const int = (v, lo, hi, def) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };

function cleanLoadout(l) {
  l = l && typeof l === 'object' ? l : {};
  const name = str(l.name, 16).replace(/[<>&"]/g, '').trim() || 'Jugador';
  return {
    id: str(l.id, 24, 'filo').replace(/[^a-z0-9_]/gi, '') || 'filo',
    lvl: int(l.lvl, 1, 5, 1), pres: int(l.pres, 0, 5, 0),
    skin: str(l.skin, 24) || null, acc: str(l.acc, 24) || null, trail: str(l.trail, 24) || null,
    style: str(l.style, 24) || 'clasica', title: str(l.title, 40) || '',
    name, trophies: int(l.trophies, 0, 99999, 0),
  };
}

function leaveQueue(ws) { queue = queue.filter(q => q !== ws); }

function tryMatch() {
  if (queue.length < 2) return;
  const now = Date.now();
  queue.sort((a, b) => a.qT - b.qT);
  const used = new Set();
  for (const a of queue) {
    if (used.has(a)) continue;
    const waitS = (now - a.qT) / 1000;
    const range = 150 + waitS * 60;              // cuanto más esperas, más amplio el rango de trofeos
    let best = null, bestD = Infinity;
    for (const b of queue) {
      if (b === a || used.has(b)) continue;
      const d = Math.abs(a.loadout.trophies - b.loadout.trophies);
      if (d <= Math.max(range, 150 + (now - b.qT) / 1000 * 60) && d < bestD) { best = b; bestD = d; }
    }
    if (best) { used.add(a); used.add(best); createRoom(a, best); }
  }
  queue = queue.filter(q => !used.has(q));
}

function createRoom(a, b) {
  const [host, guest] = Math.random() < .5 ? [a, b] : [b, a];
  const room = { id: nextRoom++, host, guest, seed: (Math.random() * 4294967295) >>> 0,
    arena: ARENAS[Math.floor(Math.random() * ARENAS.length)], t0: Date.now(), closed: false };
  host.room = guest.room = room; matchesPlayed++;
  const base = { t: 'match', room: room.id, seed: room.seed, arena: room.arena, A: host.loadout, B: guest.loadout };
  send(host, { ...base, role: 'host', you: 'A' });
  send(guest, { ...base, role: 'guest', you: 'B' });
}

function closeRoom(room, msgHost, msgGuest) {
  if (!room || room.closed) return;
  room.closed = true;
  if (room.host.room === room) room.host.room = null;
  if (room.guest.room === room) room.guest.room = null;
  if (msgHost) send(room.host, msgHost);
  if (msgGuest) send(room.guest, msgGuest);
}

function handle(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  const room = ws.room;
  switch (m.t) {
    case 'find': {
      if (room) return;
      const dev = str(m.dev, 16).toUpperCase().replace(/[^A-Z0-9-]/g, ''), ver = str(m.v, 12);
      ws.dev = dev; ws.loadout = cleanLoadout(m.loadout);
      if (dbReady && !nameMine(ws.loadout.name.toLowerCase(), dev)) ws.loadout.name = 'Jugador';   // apodo de otro jugador: no se puede usar
      console.log(`buscar · id=${dev || '?'} · apodo=${ws.loadout.name} · trofeos=${ws.loadout.trophies} · versión=${ver || '?'}`);
      if (MIN_VERSION && verNum(ver) < MIN_VERSION) { send(ws, { t: 'old' }); return; }
      if (ws.loadout.name !== 'Jugador' && mfBadName(ws.loadout.name)) { banBadName(dev, ws.loadout.name).then(bb => send(ws, Object.assign({ t: 'banned' }, banOut(bb) || { until: 0, reason: 'Nombre inapropiado' }))).catch(() => send(ws, { t: 'banned', until: 0, reason: 'Nombre inapropiado' })); return; }
      { const B = banInfo(dev, ws.loadout.name, str(m.u, 20)); if (B) { bannedNames.add(ws.loadout.name.toLowerCase()); board.delete(ws.loadout.name.toLowerCase()); send(ws, Object.assign({ t: 'banned' }, banOut(B))); return; } }
      ws.qT = Date.now(); record(ws.loadout);
      leaveQueue(ws); queue.push(ws);
      send(ws, { t: 'wait', online: clients.size, queue: queue.length });
      tryMatch();
      break; }
    case 'cancel':
      leaveQueue(ws);
      break;
    case 'snap':          // instantánea del anfitrión → invitado
      if (room && ws === room.host && m.d) send(room.guest, { t: 'snap', d: m.d });
      break;
    case 'end': {          // el anfitrión dice quién ha ganado
      if (!room || ws !== room.host) return;
      const winner = m.winner === 'A' || m.winner === 'B' ? m.winner : null;
      const msg = { t: 'end', winner, dur: Number(m.dur) || 0, d: m.d || null };
      closeRoom(room, null, msg);
      break; }
    case 'stall':          // el invitado lleva mucho sin recibir nada: el anfitrión se ha ido o se ha congelado
      if (!room || ws !== room.guest) return;
      closeRoom(room, { t: 'end', winner: 'B', reason: 'stall' }, { t: 'end', winner: 'B', reason: 'stall' });
      break;
    case 'quit':           // se rinde
      if (!room) return;
      { const w = ws === room.host ? 'B' : 'A'; closeRoom(room, { t: 'end', winner: w, reason: 'quit' }, { t: 'end', winner: w, reason: 'quit' }); }
      break;
    case 'report':         // el jugador manda sus trofeos tras un combate
      if (isBanned(ws.dev, ws.loadout && ws.loadout.name)) return;
      record(cleanLoadout(m.loadout));
      send(ws, { t: 'top', top: top3() });
      break;
    case 'top':
      send(ws, { t: 'top', top: top3() });
      break;
    case 'ping':
      send(ws, { t: 'pong', online: clients.size });
      break;
  }
}

wss.on('connection', ws => {
  ws.id = nextId++; ws.alive = true; ws.room = null; clients.add(ws);
  send(ws, { t: 'hello', online: clients.size });
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch (e) { return; } try { handle(ws, m); } catch (e) { console.error(e); } });
  ws.on('close', () => {
    clients.delete(ws); leaveQueue(ws);
    const room = ws.room;
    if (room && !room.closed) { const other = ws === room.host ? room.guest : room.host; closeRoom(room, null, null); send(other, { t: 'left' }); }
  });
});

setInterval(() => {                        // emparejar, avisar a los que esperan y cerrar salas eternas
  tryMatch();
  for (const q of queue) send(q, { t: 'wait', online: clients.size, queue: queue.length });
  const now = Date.now();
  for (const ws of clients) if (ws.room && !ws.room.closed && now - ws.room.t0 > MAX_MATCH_MS)
    closeRoom(ws.room, { t: 'end', winner: null, reason: 'timeout' }, { t: 'end', winner: null, reason: 'timeout' });
}, 2000);

setInterval(() => {                        // latido: cierra conexiones muertas
  for (const ws of clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} }
}, 25000);

server.listen(PORT, () => console.log(`Mis Bolas PVP escuchando en el puerto ${PORT}`));

/* Despierto: Render gratis duerme el servidor tras 15 min sin visitas y tarda casi un minuto en despertar.
   Cada 10 min se visita a sí mismo por su dirección pública (RENDER_EXTERNAL_URL la pone Render solo). */
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (SELF_URL && process.env.KEEP_AWAKE !== '0' && typeof fetch === 'function') {
  let fails = 0;
  setInterval(() => { fetch(SELF_URL + '/ping?t=' + Date.now(), { cache: 'no-store' }).then(r => { if (fails) console.log('despierto: vuelve a responder'); fails = 0; }).catch(e => { if (++fails === 1 || fails % 6 === 0) console.log('despierto: no se pudo llamar a ' + SELF_URL + ' (' + e.message + ')'); }); }, 10 * 60 * 1000);
  console.log('Despierto: se llamará a ' + SELF_URL + '/ping cada 10 minutos');
}
