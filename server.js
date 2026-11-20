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
//   GOOGLE_CLIENT_ID = ID de cliente de Google (termina en .apps.googleusercontent.com) para «Continuar con Google». Sin ella, el botón no sale.
//   NAME_BAN_HOURS = horas de baneo automático por apodo inapropiado (por defecto 24; 0 = indefinido)
//   KEEP_AWAKE  = 0 para que el servidor NO se llame a sí mismo cada 10 minutos (por defecto sí, para que Render gratis no se duerma)
//   MIN_VERSION = versión mínima para jugar en línea, p. ej. "v267" (vacío = cualquiera)
const BANNED = new Set(String(process.env.BANNED || '').toUpperCase().split(/[\s,;]+/).filter(Boolean));   // IDs y apodos, en mayúsculas
/* Baneos con motivo y duración: objetivo (ID MF-…, apodo o usuario, en mayúsculas) → { until: ms (0 = indefinido), reason, by, at } */
const bans = new Map();
const giftPend = new Set();
const SET = {};   // ajustes del panel guardados en la tabla settings: maint {on, msg}, notice {id, title, text, until}
async function setSet(k, v) { SET[k] = v; if (dbReady) await q(`insert into settings (k, v) values ($1, $2) on conflict (k) do update set v = $2`, [k, JSON.stringify(v)]); }
const maintOn = () => !!(SET.maint && SET.maint.on);
const noticeNow = () => { const n = SET.notice; return n && n.text && (!n.until || n.until > Date.now()) ? n : null; };
let gAll = [];   // regalos para todos activos: { id, until, claimed: Set('D:'+ID / 'A:'+cuenta) }   // 'D:'+ID o 'A:'+cuenta con regalos sin recoger
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
  if (typeof dbReady !== 'undefined' && dbReady) q('insert into ban_log (target, action, hours, reason, by_who) values ($1, $2, $3, $4, $5)', [target, 'ban', hours > 0 ? hours : 0, b.reason, b.by]).catch(() => {});
  if (typeof dbReady !== 'undefined' && dbReady) q(`insert into bans (target, reason, until, by_who) values ($1, $2, $3, $4) on conflict (target) do update set reason = $2, until = $3, by_who = $4, created = now()`, [target, b.reason, b.until, b.by]).catch(e => console.error('bans', e.message));
  return b; }
async function banDel(target) {
  target = String(target || '').trim().toUpperCase(); const b = bans.get(target); bans.delete(target);
  for (const [d, x] of banSeen) if (x === b) banSeen.delete(d);
  console.log(`DESBANEO · ${target}`);
  if (typeof dbReady !== 'undefined' && dbReady) q('insert into ban_log (target, action, by_who) values ($1, $2, $3)', [target, 'unban', 'admin']).catch(() => {});
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
  await q(`create table if not exists players (
    id text primary key references accounts(id) on delete cascade, code text unique not null,
    name text not null default 'Jugador', trophies integer not null default 0, ball text not null default 'filo', seen timestamptz not null default now())`);
  await q(`create table if not exists friends (
    a text not null references players(id) on delete cascade, b text not null references players(id) on delete cascade,
    ok boolean not null default false, created timestamptz not null default now(), primary key (a, b))`);
  await q(`create index if not exists friends_b on friends (b)`);
  await q(`create table if not exists blocks (
    a text not null references players(id) on delete cascade, b text not null references players(id) on delete cascade,
    created timestamptz not null default now(), primary key (a, b))`);
  await q(`create table if not exists reports (
    id bigserial primary key, by_who text not null, target text not null, target_name text not null default '',
    why text not null default '', created timestamptz not null default now())`);
  await q('alter table accounts add column if not exists google_sub text');
  await q('alter table accounts add column if not exists google_email text');
  await q('create unique index if not exists accounts_google on accounts (google_sub)');
  await q(`create table if not exists clubs (
    id bigserial primary key, name text not null, name_lc text unique not null, descr text not null default '', badge text not null default 'oro',
    owner text not null references players(id) on delete cascade, created timestamptz not null default now())`);
  await q(`create table if not exists club_members (
    acct text primary key references players(id) on delete cascade, club bigint not null references clubs(id) on delete cascade,
    role text not null default 'member', joined timestamptz not null default now())`);
  await q(`create index if not exists club_members_club on club_members (club)`);
  await q(`create table if not exists club_msgs (id bigserial primary key, club bigint not null references clubs(id) on delete cascade, acct text not null, name text not null, text text not null, created timestamptz not null default now())`);
  await q(`create index if not exists club_msgs_club on club_msgs (club, id)`);
  await q(`create table if not exists gifts (id bigserial primary key, target_acct text not null default '', target_dev text not null default '',
    coins integer not null default 0, gems integer not null default 0, msg text not null default '', created timestamptz not null default now(), claimed_at timestamptz, claimed_dev text not null default '')`);
  await q(`create table if not exists ban_log (id bigserial primary key, target text not null, action text not null, hours real not null default 0, reason text not null default '', by_who text not null default '', created timestamptz not null default now())`);
  await q('alter table gifts add column if not exists trophies integer not null default 0');
  await q('alter table gifts add column if not exists rename text');
  await q(`create table if not exists gift_all (id bigserial primary key, coins integer not null default 0, gems integer not null default 0, msg text not null default '', created timestamptz not null default now(), until timestamptz not null)`);
  await q(`create table if not exists gift_all_claims (gift bigint not null, who text not null, at timestamptz not null default now(), primary key (gift, who))`);
  await gAllLoad();
  for (const r of await q('select target_acct, target_dev from gifts where claimed_at is null')) { if (r.target_acct) giftPend.add('A:' + r.target_acct); if (r.target_dev) giftPend.add('D:' + r.target_dev); }
  await q(`create table if not exists settings (k text primary key, v text not null default '')`);
  for (const x of await q('select k, v from settings')) { try { SET[x.k] = JSON.parse(x.v); } catch (e) {} }
  await q(`create table if not exists matches (id bigserial primary key, created timestamptz not null default now(), kind text not null default 'comp', winner text, reason text not null default '', dur integer not null default 0,
    a_name text, a_dev text, a_user text, a_tr integer, a_card text, b_name text, b_dev text, b_user text, b_tr integer, b_card text)`);
  await q(`create index if not exists matches_created on matches (created desc)`);
  await q(`create table if not exists promos (code text primary key, coins integer not null default 0, gems integer not null default 0, max_uses integer not null default 0, uses integer not null default 0, until timestamptz, msg text not null default '', active boolean not null default true, created timestamptz not null default now())`);
  await q(`create table if not exists promo_uses (code text not null, who text not null, at timestamptz not null default now(), primary key (code, who))`);
  await q(`create table if not exists seen (dev text primary key, name text not null default '', acct text not null default '', acct_lc text not null default '', ver text not null default '',
    first_at timestamptz not null default now(), last_at timestamptz not null default now(), opens integer not null default 1)`);
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
  const rows = await q('select a.id, a.username, a.save_at, a.google_email, a.passhash from sessions s join accounts a on a.id = s.acct where s.tokhash = $1', [sha(tok)]);
  if (!rows.length) return null; q('update sessions set seen = now() where tokhash = $1', [sha(tok)]).catch(() => {}); return rows[0]; }
/* ---------- v297 · Entrar con Google: se comprueba la firma del token con las claves públicas de Google (sin librerías) ---------- */
let gKeys = { at: 0, keys: {} };
async function gCerts(force) {
  if (!force && Date.now() < gKeys.at) return gKeys.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs'); const j = await r.json();
  const ma = /max-age=(\d+)/.exec(r.headers.get('cache-control') || ''); const keys = {};
  for (const k of j.keys || []) { try { keys[k.kid] = crypto.createPublicKey({ key: k, format: 'jwk' }); } catch (e) {} }
  gKeys = { at: Date.now() + (ma ? Number(ma[1]) * 1000 : 3600e3), keys }; return keys;
}
async function gVerify(tok) {
  const CID = process.env.GOOGLE_CLIENT_ID; if (!CID || typeof tok !== 'string' || tok.length > 4096) return null;
  const p = tok.split('.'); if (p.length !== 3) return null;
  let h, pl; try { h = JSON.parse(Buffer.from(p[0], 'base64url')); pl = JSON.parse(Buffer.from(p[1], 'base64url')); } catch (e) { return null; }
  if (h.alg !== 'RS256') return null;
  let keys = await gCerts(); let key = keys[h.kid]; if (!key) { keys = await gCerts(true); key = keys[h.kid]; } if (!key) return null;
  if (!crypto.verify('RSA-SHA256', Buffer.from(p[0] + '.' + p[1]), key, Buffer.from(p[2], 'base64url'))) return null;
  if (pl.aud !== CID || !['accounts.google.com', 'https://accounts.google.com'].includes(pl.iss) || !(Number(pl.exp) * 1000 > Date.now()) || !pl.sub) return null;
  return pl;
}
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
    const rows = await q('select id, username, passhash, save, save_at, google_email from accounts where user_lc = $1', [user.toLowerCase()]);
    if (!rows.length || !(await checkPass(pass, rows[0].passhash))) { hit(lockKey, 10, 15 * 60e3); return { err: 'bad' }; }
    rate.delete(lockKey); const A = rows[0];
    { const b = banInfo(dev, '', A.username); if (b) return { err: 'banned', ban: banOut(b) }; }
    q('update accounts set seen = now(), last_dev = $2 where id = $1', [A.id, dev]).catch(() => {});
    console.log(`entrar · ${A.username} · id=${dev || '?'}`);
    return { ok: true, user: A.username, token: await newSession(A.id, dev), save: A.save || null, at: Number(A.save_at) || 0, g: A.google_email || '' };
  }
  if (a === 'google') {   // entrar (o crear la cuenta) con Google
    if (!process.env.GOOGLE_CLIENT_ID) return { err: 'nogoogle' };
    if (hit('google:' + ip, 20, 60e3)) return { err: 'slow' };
    let G = null; try { G = await gVerify(body.credential); } catch (e) { console.error('google', e.message); return { err: 'server' }; }
    if (!G) return { err: 'gbad' };
    const rows = await q('select id, username, save, save_at, passhash from accounts where google_sub = $1', [String(G.sub)]);
    if (rows.length) { const A = rows[0];
      { const b = banInfo(dev, '', A.username); if (b) return { err: 'banned', ban: banOut(b) }; }
      q('update accounts set seen = now(), last_dev = $2, google_email = $3 where id = $1', [A.id, dev, String(G.email || '')]).catch(() => {});
      console.log(`entrar con Google · ${A.username} · id=${dev || '?'}`);
      return { ok: true, user: A.username, token: await newSession(A.id, dev), save: A.save || null, at: Number(A.save_at) || 0, g: G.email || '', np: String(A.passhash || '').startsWith('g$') };
    }
    const user = String(body.user || '').trim();
    if (!user) return { need: 'user', email: G.email || '', suggest: String(G.given_name || '').replace(/[^A-Za-z0-9_ñÑáéíóúÁÉÍÓÚüÜ.-]/g, '').slice(0, 16) };
    if (!USER_RE.test(user)) return { err: 'user' };
    if (mfBadName(user)) return { err: 'baduser' };
    if (hit('reg:' + ip, SIGNUP_LIMIT, 3600e3)) return { err: 'slow' };
    { const b = banInfo(dev, '', user); if (b) return { err: 'banned', ban: banOut(b) }; }
    const save = cleanSave(body.save), at = Date.now(), id = 'A' + crypto.randomBytes(8).toString('hex');
    try { await q('insert into accounts (id, user_lc, username, passhash, save, save_at, last_dev, google_sub, google_email) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [id, user.toLowerCase(), user, 'g$', save, save ? at : 0, dev, String(G.sub), String(G.email || '')]); }
    catch (e) { if (/unique|duplicate/i.test(e.message)) return { err: /google/i.test(e.message) ? 'gtaken' : 'taken' }; throw e; }
    console.log(`cuenta nueva con Google · ${user} · id=${dev || '?'}`);
    return { ok: true, created: true, user, token: await newSession(id, dev), at: save ? at : 0, g: G.email || '' };
  }
  if (a === 'promo') {   // v298 · canjear un código promocional (una vez por cuenta y por móvil)
    if (!dev) return { err: 'promo_bad' };
    if (hit('promo:' + ip, 12, 60e3) || hit('promo:' + dev, 8, 60e3)) return { err: 'slow' };
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24); if (!code) return { err: 'promo_bad' };
    const A = body.token ? await bySession(body.token) : null;
    if (banInfo(dev, '', A ? A.username : '')) return { err: 'banned' };
    const P = (await q(`select code, coins, gems, msg, max_uses, uses, active, (until is not null and until < now()) as late from promos where code = $1`, [code]))[0];
    if (!P || !P.active) return { err: 'promo_bad' };
    if (P.late) return { err: 'promo_late' };
    if (P.max_uses > 0 && P.uses >= P.max_uses) return { err: 'promo_full' };
    const whos = ['D:' + dev, ...(A ? ['A:' + A.id] : [])];
    const used = await q(`select 1 from promo_uses where code = $1 and (who = $2 or who = $3)`, [code, whos[0], whos[1] || whos[0]]); if (used.length) return { err: 'promo_used' };
    const up = await q(`update promos set uses = uses + 1 where code = $1 and (max_uses = 0 or uses < max_uses) returning uses`, [code]); if (!up.length) return { err: 'promo_full' };
    for (const w of whos) await q(`insert into promo_uses (code, who) values ($1, $2) on conflict do nothing`, [code, w]);
    console.log(`CÓDIGO canjeado · ${code} · ${A ? A.username : dev}`);
    return { ok: true, coins: Number(P.coins) || 0, gems: Number(P.gems) || 0, msg: P.msg || '' };
  }
  if (a === 'gift') {   // regalos del panel: por ID de dispositivo o por cuenta (con sesión)
    const A = body.token ? await bySession(body.token) : null; if (!dev) return { ok: true, gifts: [] };
    if (hit('gift:' + dev, 20, 60e3)) return { err: 'slow' };
    const rows = await q(`update gifts set claimed_at = now(), claimed_dev = $1 where claimed_at is null and (target_dev = $1 or ($2 <> '' and target_acct = $2)) returning coins, gems, trophies, msg, rename`, [dev, A ? A.id : '']);
    giftPend.delete('D:' + dev); if (A) giftPend.delete('A:' + A.id);
    let all = []; try { all = await gAllClaim(dev, A ? A.id : ''); } catch (e) { console.error('regalo todos', e.message); }
    if (all.length) { rows.push(...all); console.log(`REGALO PARA TODOS recogido · ${A ? A.username : dev}`); }
    if (rows.length) console.log(`REGALO recogido · ${A ? A.username : dev} · ${rows.map(g => g.coins + ' monedas, ' + g.gems + ' gemas' + (Number(g.trophies) ? ', ' + g.trophies + ' trofeos' : '')).join(' | ')}`);
    return { ok: true, gifts: rows.map(g => ({ coins: Number(g.coins) || 0, gems: Number(g.gems) || 0, trophies: Number(g.trophies) || 0, msg: g.msg || '', ...(g.rename != null ? { rename: g.rename } : {}) })) };
  }
  const A = await bySession(body.token); if (!A) return { err: 'auth' };
  if (a === 'meta') { const ex = { g: A.google_email || '', np: String(A.passhash || '').startsWith('g$') }; const b = banInfo(dev, '', A.username); if (b) return { ok: true, user: A.username, at: Number(A.save_at) || 0, banned: true, ban: banOut(b), ...ex }; return { ok: true, user: A.username, at: Number(A.save_at) || 0, ...ex }; }
  if (a === 'glink') {   // vincular la cuenta con Google (para entrar aunque se olvide la contraseña)
    let G = null; try { G = await gVerify(body.credential); } catch (e) { return { err: 'server' }; } if (!G) return { err: process.env.GOOGLE_CLIENT_ID ? 'gbad' : 'nogoogle' };
    const o = await q('select id from accounts where google_sub = $1', [String(G.sub)]); if (o.length && o[0].id !== A.id) return { err: 'gtaken' };
    await q('update accounts set google_sub = $2, google_email = $3 where id = $1', [A.id, String(G.sub), String(G.email || '')]);
    console.log(`vincular Google · ${A.username}`); return { ok: true, g: G.email || '' };
  }
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
    const r = await q('select passhash from accounts where id = $1', [A.id]); if (!String(r[0].passhash).startsWith('g$') && !(await checkPass(old, r[0].passhash))) return { err: 'bad' };
    await q('update accounts set passhash = $2 where id = $1', [A.id, await hashPass(nw)]);
    await q('delete from sessions where acct = $1 and tokhash <> $2', [A.id, sha(body.token)]); return { ok: true };
  }
  return { err: 'what' };
}
function acctHttp(req, res) {
  const out = (code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (req.method === 'OPTIONS') return out(204, {});
  if (/^\/acct\/config(\?|$)/.test(req.url)) return out(200, { google: process.env.GOOGLE_CLIENT_ID || '' });
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

/* ---------- lista de jugadores para /admin: cada ID que abre el juego queda apuntado (como mucho una escritura por ID y minuto) ---------- */
const seenT = new Map();
function seenNote(dev, name, user, ver) {
  if (typeof dbReady === 'undefined' || !dbReady) return; const now = Date.now(); if (now - (seenT.get(dev) || 0) < 60e3) return; seenT.set(dev, now);
  if (seenT.size > 20000) seenT.clear();
  name = String(name || '').trim(); user = String(user || '').trim();
  q(`insert into seen (dev, name, acct, acct_lc, ver) values ($1, $2, $3, $4, $5) on conflict (dev) do update set
     name = case when $2 = '' then seen.name else $2 end, acct = case when $3 = '' then seen.acct else $3 end, acct_lc = case when $4 = '' then seen.acct_lc else $4 end,
     ver = case when $5 = '' then seen.ver else $5 end, last_at = now(), opens = seen.opens + 1`, [dev, name, user, user.toLowerCase(), String(ver || '')]).catch(e => console.error('seen', e.message));
}
async function playersFind(qs) {
  qs = String(qs || '').trim().toLowerCase().replace(/[%_\\]/g, '').slice(0, 30);
  const rows = await q(`select x.dev, x.name, x.usr, x.ver, x.last_ms, x.opens, x.code, x.trophies, x.pname from (
      select s.dev, s.name, coalesce(a.username, nullif(s.acct, '')) as usr, s.ver, (extract(epoch from s.last_at) * 1000)::bigint as last_ms, s.opens, p.code, p.trophies, p.name as pname
        from seen s left join accounts a on a.user_lc = s.acct_lc and s.acct_lc <> '' left join players p on p.id = a.id
      union all
      select a.last_dev, coalesce(p.name, ''), a.username, '', null, 0, p.code, p.trophies, p.name
        from accounts a left join players p on p.id = a.id where not exists (select 1 from seen s2 where s2.acct_lc = a.user_lc)
    ) x where $1 = '' or lower(concat_ws(' ', x.dev, x.name, x.usr, x.code, x.pname)) like '%' || $1 || '%'
    order by x.last_ms desc nulls last limit 100`, [qs]);
  const total = (await q('select count(*)::int as n from seen'))[0].n, accts = (await q('select count(*)::int as n from accounts'))[0].n;
  return { rows, total, accts };
}
const banWhy = (dev, name, user) => { for (const k of [dev, user, name && name.toUpperCase() !== 'JUGADOR' ? name : '']) { const K = String(k || '').trim().toUpperCase(); if (K && banLive(bans.get(K))) return K; }
  return dev && banLive(banSeen.get(String(dev).toUpperCase())) ? 'por otro ID' : ''; };


/* ---------- regalos para todos: cada móvil (o cuenta) lo recoge una vez mientras esté activo ---------- */
async function gAllLoad() {
  const rows = await q(`select id, ${'(extract(epoch from until) * 1000)::bigint'} as until_ms from gift_all where until > now()`);
  const list = [];
  for (const g of rows) { const set = new Set(); for (const c of await q('select who from gift_all_claims where gift = $1', [g.id])) set.add(c.who); list.push({ id: Number(g.id), until: Number(g.until_ms), claimed: set }); }
  gAll = list;
}
const gAllPending = (dev, acct) => gAll.some(g => g.until > Date.now() && !g.claimed.has('D:' + dev) && !(acct && g.claimed.has('A:' + acct)));
async function gAllClaim(dev, acct) {
  const out = [];
  for (const g of gAll) {
    if (g.until <= Date.now() || g.claimed.has('D:' + dev) || (acct && g.claimed.has('A:' + acct))) continue;
    if (acct) { const x = await q('insert into gift_all_claims (gift, who) values ($1, $2) on conflict do nothing returning gift', [g.id, 'A:' + acct]); g.claimed.add('A:' + acct); if (!x.length) continue; }
    const y = await q('insert into gift_all_claims (gift, who) values ($1, $2) on conflict do nothing returning gift', [g.id, 'D:' + dev]); g.claimed.add('D:' + dev); if (!y.length && !acct) continue;
    const d = (await q('select coins, gems, msg from gift_all where id = $1', [g.id]))[0]; if (d) out.push({ coins: Number(d.coins) || 0, gems: Number(d.gems) || 0, trophies: 0, msg: d.msg || '' });
  }
  return out;
}

/* ---------- panel: estadísticas y ficha de jugador ---------- */
const msOf = c => `(extract(epoch from ${c}) * 1000)::bigint`;
const whenES = ms => ms ? new Date(Number(ms)).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const agoES = ms => { if (!ms) return '—'; const s = Math.max(0, (Date.now() - Number(ms)) / 1000 | 0); return s < 120 ? 'ahora' : s < 3600 ? `hace ${s / 60 | 0} min` : s < 86400 ? `hace ${s / 3600 | 0} h` : `hace ${s / 86400 | 0} d`; };
async function adminStats() {
  const one = async (sql, p) => { try { return (await q(sql, p || []))[0] || {}; } catch (e) { console.error('stats', e.message); return {}; } };
  const sn = await one(`select count(*) filter (where last_at > now() - interval '24 hours')::int as d1, count(*) filter (where last_at > now() - interval '7 days')::int as d7,
    count(*) filter (where first_at > now() - interval '24 hours')::int as n1, count(*) filter (where first_at > now() - interval '7 days')::int as n7, count(*)::int as tot from seen`);
  const ac = await one(`select count(*)::int as tot, count(*) filter (where created > now() - interval '24 hours')::int as n1, count(*) filter (where created > now() - interval '7 days')::int as n7 from accounts`);
  const cl = await one('select count(*)::int as n from clubs');
  let vers = []; try { vers = await q(`select ver, count(*)::int as n from seen where last_at > now() - interval '7 days' and ver <> '' group by ver order by n desc limit 8`); } catch (e) {}
  const playing = [...clients].filter(c => c.room && !c.room.closed).length / 2 | 0;
  return { sn, ac, cl, vers, online: online.size, conns: clients.size, playing, queue: queue.length, matches: matchesPlayed, up: process.uptime() };
}
async function playerInfo(dev, usr) {
  dev = String(dev || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20); usr = String(usr || '').trim().slice(0, 30);
  const accSql = `select a.id, a.username, a.last_dev, ${msOf('a.created')} as created_ms, ${msOf('a.seen')} as seen_ms, p.code, p.name, p.trophies, p.ball from accounts a left join players p on p.id = a.id where `;
  let acc = usr ? (await q(accSql + 'a.user_lc = $1', [usr.toLowerCase()]))[0] : null;
  if (!acc && dev && devAcct.get(dev)) acc = (await q(accSql + 'a.id = $1', [devAcct.get(dev)]))[0];
  acc = acc || null;
  const devs = await q(`select dev, name, acct, ver, opens, ${msOf('first_at')} as first_ms, ${msOf('last_at')} as last_ms from seen where dev = $1 or ($2 <> '' and acct_lc = $2) order by last_at desc limit 20`, [dev, acc ? acc.username.toLowerCase() : '']);
  if (acc) for (const x of await q(`select distinct dev from sessions where acct = $1 and dev <> ''`, [acc.id])) if (!devs.some(d => d.dev === x.dev)) devs.push({ dev: x.dev });
  if (dev && !devs.some(d => d.dev === dev)) devs.unshift({ dev });
  let friends = [], club = null, repIn = [], repOut = [];
  if (acc) {
    friends = await q(`select p.name, p.code, p.trophies, f.ok from friends f join players p on p.id = (case when f.a = $1 then f.b else f.a end) where f.a = $1 or f.b = $1 order by f.ok desc, p.name limit 100`, [acc.id]);
    club = (await q(`select c.name, m.role, (select count(*)::int from club_members m2 where m2.club = c.id) as n from club_members m join clubs c on c.id = m.club where m.acct = $1`, [acc.id]))[0] || null;
    repIn = await q(`select r.why, r.target_name, ba.username as other, ${msOf('r.created')} as ts from reports r left join accounts ba on ba.id = r.by_who where r.target = $1 order by r.created desc limit 20`, [acc.id]);
    repOut = await q(`select r.why, r.target_name, ta.username as other, ${msOf('r.created')} as ts from reports r left join accounts ta on ta.id = r.target where r.by_who = $1 order by r.created desc limit 20`, [acc.id]);
  }
  const gifts = await q(`select coins, gems, trophies, rename, msg, ${msOf('created')} as ts, ${msOf('claimed_at')} as cl from gifts where ($1 <> '' and target_acct = $1) or ($2 <> '' and target_dev = $2) order by created desc limit 20`, [acc ? acc.id : '', dev]);
  const names = [...new Set([acc && acc.name, ...devs.map(d => d.name)].filter(n => n && n.toUpperCase() !== 'JUGADOR'))];
  const keys = [...new Set([acc && acc.username, ...devs.map(d => d.dev), ...names].filter(Boolean).map(k => String(k).toUpperCase()))];
  const blog = keys.length ? await q(`select target, action, hours, reason, by_who, ${msOf('created')} as ts from ban_log where target in (${keys.map((_, i) => '$' + (i + 1)).join(', ')}) order by created desc limit 30`, keys) : [];
  const live = keys.map(k => [k, bans.get(k)]).filter(([, b]) => banLive(b));
  const seenBan = devs.map(d => banSeen.get(d.dev)).find(banLive);
  return { dev, acc, devs, friends, club, repIn, repOut, gifts, names, keys, blog, live, seenBan };
}
/* ================= Panel de admin: https://…onrender.com/admin (contraseña ADMIN_KEY) =================
   Apartados: Inicio · Jugadores (y ficha) · Baneos · Regalos · Denuncias · Más (Juego, Códigos, Clubs, Combates).
   Se entra una vez con la contraseña y queda una cookie de sesión (12 h); al reiniciar el servidor hay que volver a entrar. */
const escH = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const admSess = new Map();
function admAuthed(req) {
  const m = /(?:^|;\s*)mfadm=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || ''); if (!m) return null;
  const e = admSess.get(m[1]); if (!e || e < Date.now()) { admSess.delete(m[1]); return null; } return m[1];
}
const admUrl = (t, o) => '/admin?' + new URLSearchParams(Object.assign({ t }, o || {})).toString();
const IC = {
  home: '<path d="M3 11.5 12 4l9 7.5M5.5 9.8V20h13V9.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>',
  users: '<path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2.5 21v-.5a6.5 6.5 0 0 1 13 0v.5M16 3.3a4 4 0 0 1 0 7.6M21.5 21v-.5a6.5 6.5 0 0 0-3.8-5.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  ban: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5.6 5.6l12.8 12.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  gift: '<path d="M4 11h16v10H4zM3 7h18v4H3zM12 7v14M12 7S10.5 3 8 3.5 7 7 12 7zm0 0s1.5-4 4-3.5S17 7 12 7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  flag: '<path d="M5 21V4m0 0h11l-2 4 2 4H5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>',
  out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  search: '<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M12 14v4M8 21h8M9 18h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>',
  back: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  chev: '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  dot: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
  more: '<circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/>',
  megaphone: '<path d="M3 10v4h3l7 4V6L6 10zM16.5 8.5a5 5 0 0 1 0 7M6 14l1.5 5h3L9 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 1.3-1.3M14.7 6.3 13 4.6a4 4 0 0 0-5 5L3 14.6 9.4 21l5-5a4 4 0 0 0 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 0 4v0a2 2 0 0 0 0 4v2h18v-2a2 2 0 0 1 0-4 2 2 0 0 1 0-4V6H3zM14 6v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-dasharray="0"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  swords: '<path d="M14.5 3H21v6.5L9 21.5 2.5 15zM9.5 3H3v6.5L15 21.5l6.5-6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
};
const ic = (n, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${IC[n]}</svg>`;
const ADM_CSS = `:root{--bg:#120c10;--card:#211820;--in:#171015;--line:#35262f;--gold:#ffd54a;--txt:#f5ecf1;--mut:#b4a3ad;--red:#ff8f99;--grn:#8ee6a8;--blue:#9fd0ff;color-scheme:dark}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--txt);font:15.5px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
.ic{width:22px;height:22px;flex:none}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 16px 10px;background:rgba(18,12,16,.9);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
header h1{flex:1;margin:0;font-size:19px;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.logo{width:32px;height:32px;border-radius:10px;background:linear-gradient(180deg,#ffe76e,#f5a800);display:grid;place-items:center;color:#2a1a05;font-weight:900;font-size:15px;flex:none;box-shadow:inset 0 1px 0 rgba(255,255,255,.5)}
.hb{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;color:var(--mut);background:transparent;border:0;text-decoration:none}
.hb:active{background:#2a1f27}
main{max-width:760px;margin:0 auto;padding:14px 14px calc(92px + env(safe-area-inset-bottom))}
nav.tabs{position:fixed;left:0;right:0;bottom:0;z-index:6;display:grid;grid-template-columns:repeat(6,1fr);background:rgba(24,17,21,.95);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
nav.tabs a{display:grid;justify-items:center;gap:3px;padding:9px 0 8px;color:var(--mut);text-decoration:none;font-size:11px;font-weight:650;position:relative;white-space:nowrap}
nav.tabs a .ic{width:24px;height:24px}
nav.tabs a.on{color:var(--gold)}
nav.tabs a.on::before{content:"";position:absolute;top:0;left:30%;right:30%;height:3px;border-radius:0 0 3px 3px;background:var(--gold)}
nav.tabs .bd{position:absolute;top:4px;left:calc(50% + 7px);min-width:18px;height:18px;border-radius:9px;background:#e5484d;color:#fff;font-size:11px;font-weight:800;display:grid;place-items:center;padding:0 5px}
@media (min-width:900px){body{padding-left:96px}nav.tabs{top:0;right:auto;width:96px;grid-template-columns:1fr;align-content:start;gap:4px;padding-top:76px;border-top:0;border-right:1px solid var(--line)}nav.tabs a.on::before{top:20%;bottom:20%;left:0;right:auto;width:3px;height:auto;border-radius:0 3px 3px 0}main{padding-bottom:40px}}
.card{background:var(--card);border-radius:18px;padding:16px;margin-bottom:12px;border:1px solid rgba(255,255,255,.045)}
.card>h2{margin:0 0 12px;font-size:16.5px;display:flex;align-items:center;gap:8px}.card>h2 .ic{color:var(--gold);width:20px;height:20px}.card>h2 small{margin-left:auto;color:var(--mut);font-weight:600;font-size:13px}
.flash{display:flex;gap:10px;align-items:center;padding:12px 14px;border-radius:14px;margin-bottom:12px;background:rgba(142,230,168,.1);border:1px solid rgba(142,230,168,.35);color:#c9f5d6;font-weight:600}
.flash.err{background:rgba(255,143,153,.1);border-color:rgba(255,143,153,.4);color:#ffd0d5}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}@media (min-width:560px){.stats{grid-template-columns:repeat(3,1fr)}}
.st{background:var(--in);border-radius:14px;padding:12px}.st b{display:block;font-size:26px;line-height:1.1;color:#fff;font-variant-numeric:tabular-nums}.st small{color:var(--mut);font-size:12.5px}
.st.hi{background:linear-gradient(180deg,#3a2c12,#251c10);box-shadow:inset 0 0 0 1px rgba(255,213,74,.35)}.st.hi b{color:var(--gold)}
.live{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--grn);box-shadow:0 0 8px var(--grn);margin-right:6px;vertical-align:1px}
.bar{display:flex;height:10px;border-radius:6px;overflow:hidden;background:var(--in);margin:6px 0}.bar i{display:block;height:100%}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px;color:var(--mut)}.legend b{color:var(--txt)}.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px}
.quick{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.quick a{display:grid;justify-items:center;gap:6px;padding:14px 6px;border-radius:14px;background:var(--in);color:var(--txt);text-decoration:none;font-size:13px;font-weight:650;text-align:center}.quick a .ic{color:var(--gold);width:26px;height:26px}.quick a:active{background:#2a1f27}
.list{display:grid}.list>*{min-width:0}.it form{flex:none;margin:0}.stats.c3{grid-template-columns:repeat(3,1fr)}.stats.c3 .st b{font-size:24px}.acc{color:var(--blue);font-weight:700}.it{display:flex;align-items:center;gap:12px;padding:11px 2px;border-top:1px solid var(--line);color:inherit;text-decoration:none}.list>.it:first-child{border-top:0}
a.it:active{background:rgba(255,255,255,.03)}
.av{width:40px;height:40px;border-radius:50%;flex:none;display:grid;place-items:center;font-weight:800;font-size:16px;color:#2a1a05;background:linear-gradient(180deg,#ffe76e,#e0a020)}.av.g{background:linear-gradient(180deg,#5a4a55,#3a2d36);color:#fff}.av.r{background:linear-gradient(180deg,#ff8f99,#c8203a);color:#fff}.av.b{background:linear-gradient(180deg,#9fd0ff,#2563d9);color:#fff}
.av .ic{width:20px;height:20px}
.tx{flex:1;min-width:0}.tx b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tx small{display:block;color:var(--mut);font-size:13px;overflow-wrap:anywhere}
.it>.ic{color:#6f5d68;width:18px;height:18px}
.chip{display:inline-block;font-size:11.5px;font-weight:800;letter-spacing:.02em;border-radius:7px;padding:1px 7px;margin-left:6px;vertical-align:2px;background:#1f3d5a;color:#bfe0ff}.chip.r{background:#5a1f2e;color:#ffc2c4}.chip.g{background:#1f4a30;color:#bff5cf}.chip.y{background:#4a3a12;color:#ffe08a}
label{display:block;font-size:13px;font-weight:600;color:var(--mut);margin:10px 0 5px}
input,select{width:100%;height:46px;border-radius:12px;border:1.5px solid var(--line);background:var(--in);color:#fff;padding:0 13px;font:inherit;font-size:16px;outline:none;-webkit-appearance:none;appearance:none}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M6 9l6 6 6-6' fill='none' stroke='%23b4a3ad' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:18px;padding-right:38px}
input:focus,select:focus{border-color:#a8873a;box-shadow:0 0 0 3px rgba(255,213,74,.15)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.three{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:48px;padding:0 18px;border-radius:13px;border:0;font:inherit;font-weight:750;font-size:15.5px;cursor:pointer;text-decoration:none;background:#3a2d36;color:#fff;margin-top:14px;width:100%}
.btn.gold{background:linear-gradient(180deg,#ffe36a,#f5ab00);color:#2a1a05;box-shadow:inset 0 1px 0 rgba(255,255,255,.5)}.btn.red{background:linear-gradient(180deg,#e5545f,#a91f34);color:#fff}.btn.sm{height:38px;width:auto;margin:0;padding:0 14px;font-size:14px;border-radius:11px}
.btn:active{filter:brightness(1.12);transform:translateY(1px)}
.srch{display:flex;gap:8px;position:sticky;top:calc(59px + env(safe-area-inset-top));z-index:3;background:var(--bg);padding:2px 0 10px;margin-top:-2px}.srch input{padding-left:40px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='11' cy='11' r='7' fill='none' stroke='%23b4a3ad' stroke-width='2'/%3E%3Cpath d='m20 20-4-4' stroke='%23b4a3ad' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:12px center;background-size:20px}.srch .btn{margin:0;width:auto;height:46px}
.hint{color:var(--mut);font-size:13px;margin:8px 0 0}
.none{color:var(--mut);font-size:14px;margin:4px 0}
.hero{display:flex;gap:14px;align-items:center}.hero .av{width:62px;height:62px;font-size:26px}.hero h2{margin:0;font-size:22px}.hero .tx small{font-size:13.5px}
.kv{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:14px}.kv div{background:var(--in);border-radius:12px;padding:9px 11px}.kv span{display:block;color:var(--mut);font-size:12px}.kv b{font-size:15px;overflow-wrap:anywhere}
.state{display:flex;align-items:center;gap:10px;margin-top:12px;padding:11px 12px;border-radius:13px;background:rgba(142,230,168,.08);color:#c9f5d6;font-weight:650}.state.r{background:rgba(255,143,153,.1);color:#ffd0d5}.state .tx small{color:#e9b9bf}.state form{margin:0}
.seg{display:flex;gap:6px;overflow-x:auto;margin:0 -2px 12px;padding:0 2px 2px;scrollbar-width:none}.seg::-webkit-scrollbar{display:none}
.seg a{flex:none;padding:8px 14px;border-radius:20px;background:var(--card);color:var(--mut);text-decoration:none;font-size:14px;font-weight:650;border:1px solid var(--line)}.seg a.on{background:#3a2c12;color:var(--gold);border-color:rgba(255,213,74,.4)}
textarea{width:100%;border-radius:12px;border:1.5px solid var(--line);background:var(--in);color:#fff;padding:11px 13px;font:inherit;font-size:16px;outline:none;resize:vertical;-webkit-appearance:none}textarea:focus{border-color:#a8873a;box-shadow:0 0 0 3px rgba(255,213,74,.15)}
.mrow{padding:11px 0;border-top:1px solid var(--line)}.list>.mrow:first-child{border-top:0}.mhead{display:flex;align-items:center;gap:8px;margin-bottom:7px}.mhead small{color:var(--mut);font-size:12.5px}.mvs{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center}.vs{color:var(--mut);font-weight:900;font-size:12px}.mside{display:block;min-width:0;background:var(--in);border-radius:12px;padding:8px 10px;color:inherit;text-decoration:none}.mside.w{box-shadow:inset 0 0 0 1.5px rgba(255,213,74,.55)}.mside b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14.5px}.mside small{display:block;color:var(--mut);font-size:12px;overflow-wrap:anywhere}
.login{min-height:100vh;display:grid;place-items:center;padding:24px}.login form{width:100%;max-width:360px;text-align:center}.login .logo{width:64px;height:64px;font-size:30px;border-radius:18px;margin:0 auto 14px}.login h1{margin:0 0 4px;font-size:24px}.login p{color:var(--mut);margin:0 0 18px}.login .err{color:var(--red);font-weight:600}`;
function admShell(tab, title, body, opt) {
  opt = opt || {};
  const T = [['home', 'Inicio', 'home'], ['players', 'Jugadores', 'users'], ['bans', 'Baneos', 'ban'], ['gifts', 'Regalos', 'gift'], ['reports', 'Denuncias', 'flag'], ['more', 'Más', 'more']];
  const nav = T.map(([t, l, i]) => `<a href="${admUrl(t)}" class="${tab === t ? 'on' : ''}">${ic(i)}<span>${l}</span>${opt.badges && opt.badges[t] ? `<span class="bd">${opt.badges[t]}</span>` : ''}</a>`).join('');
  const flash = opt.m ? `<div class="flash${opt.err ? ' err' : ''}" role="status">${escH(opt.m)}</div>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#120c10"><meta name="robots" content="noindex"><title>${escH(title)} · Panel Marble Fights</title><style>${ADM_CSS}</style></head><body>
<header>${opt.back ? `<a class="hb" href="${escH(opt.back)}" aria-label="Volver">${ic('back')}</a>` : '<span class="logo">M</span>'}<h1>${escH(title)}</h1><form method="post" action="/admin" style="margin:0"><input type="hidden" name="a" value="logout"><button class="hb" aria-label="Salir" title="Salir">${ic('out')}</button></form></header>
<main>${flash}${body}</main><nav class="tabs" aria-label="Apartados">${nav}</nav></body></html>`;
}
const hidF = (a, back, extra) => `<input type="hidden" name="a" value="${a}"><input type="hidden" name="back" value="${escH(back)}">${Object.entries(extra || {}).map(([k, v]) => `<input type="hidden" name="${k}" value="${escH(v)}">`).join('')}`;
const HOURS = `<option value="1">1 hora</option><option value="6">6 horas</option><option value="24" selected>24 horas</option><option value="72">3 días</option><option value="168">7 días</option><option value="720">30 días</option><option value="0">Para siempre</option>`;
const banLeft = b => { if (!b.until) return 'para siempre'; const s = Math.max(0, (b.until - Date.now()) / 1000 | 0), d = s / 86400 | 0, h = (s % 86400) / 3600 | 0, m = (s % 3600) / 60 | 0; return 'quedan ' + (d ? d + ' d ' : '') + (h ? h + ' h ' : '') + m + ' min'; };
const ini = n => escH((String(n || '?').trim()[0] || '?').toUpperCase());
const fmtN = n => Number(n || 0).toLocaleString('es-ES');
const plLink = (dev, usr) => admUrl('player', Object.assign({}, dev ? { dev } : {}, usr ? { usr } : {}));

/* ---------- Inicio ---------- */
async function admHome() {
  const st = await adminStats();
  let lastBans = [], lastReps = [];
  try { lastBans = await q(`select target, action, hours, reason, ${msOf('created')} as ts from ban_log order by created desc limit 5`); } catch (e) {}
  try { lastReps = await q(`select r.why, r.target_name, ta.username as tuser, ${msOf('r.created')} as ts from reports r left join accounts ta on ta.id = r.target order by r.created desc limit 5`); } catch (e) {}
  const box = (n, l, hi) => `<div class="st${hi ? ' hi' : ''}"><b>${n == null ? '—' : fmtN(n)}</b><small>${l}</small></div>`;
  const up = st.up / 3600 | 0, vtot = st.vers.reduce((s, v) => s + v.n, 0) || 1, VC = ['#ffd54a', '#9fd0ff', '#8ee6a8', '#ff8f99', '#c79bff', '#ffb36b', '#7ee0d6', '#b4a3ad'];
  return `<div class="card"><h2>${ic('dot')}Ahora mismo</h2><div class="stats c3">${box(st.online, '<span class="live"></span>conectados', 1)}${box(st.playing, 'combates en curso', 1)}${box(st.queue, 'buscando partida', 1)}</div></div>
<div class="card"><h2>${ic('users')}Jugadores</h2><div class="stats">${box(st.sn.d1, 'últimas 24 h')}${box(st.sn.d7, 'últimos 7 días')}${box(st.sn.tot, 'en total (móviles)')}${box(st.sn.n1, 'nuevos en 24 h')}${box(st.sn.n7, 'nuevos en 7 días')}${box(st.ac.tot, `cuentas · ${fmtN(st.ac.n1)} nuevas hoy`)}${box(st.cl.n, 'clubs')}${box(st.matches, `combates en línea · ${up < 48 ? up + ' h' : (up / 24 | 0) + ' d'} encendido`)}</div>
${st.vers.length ? `<label>Versiones del juego (7 días)</label><div class="bar">${st.vers.map((v, i) => `<i style="width:${(v.n / vtot * 100).toFixed(1)}%;background:${VC[i % 8]}"></i>`).join('')}</div><div class="legend">${st.vers.map((v, i) => `<span><i style="background:${VC[i % 8]}"></i>${escH(v.ver)} <b>${v.n}</b></span>`).join('')}</div>` : ''}</div>
<div class="card"><h2>${ic('chev')}Accesos rápidos</h2><div class="quick"><a href="${admUrl('players')}">${ic('search')}Buscar jugador</a><a href="${admUrl('bans')}">${ic('ban')}Banear</a><a href="${admUrl('gifts')}">${ic('gift')}Regalo a todos</a></div></div>
<div class="card"><h2>${ic('ban')}Últimos baneos<small><a href="${admUrl('bans')}" style="color:var(--gold)">Ver todos</a></small></h2><div class="list">${lastBans.map(x => `<a class="it" href="${admUrl('players', { q: x.target })}"><span class="av ${x.action === 'ban' ? 'r' : 'g'}">${ic(x.action === 'ban' ? 'ban' : 'dot')}</span><span class="tx"><b>${escH(x.target)}</b><small>${x.action === 'ban' ? (Number(x.hours) ? Number(x.hours) + ' h' : 'para siempre') + ' · ' + escH(x.reason || 'sin motivo') : 'desbaneado'} · ${agoES(x.ts)}</small></span>${ic('chev')}</a>`).join('') || '<p class="none">Ninguno todavía.</p>'}</div></div>
<div class="card"><h2>${ic('flag')}Últimas denuncias<small><a href="${admUrl('reports')}" style="color:var(--gold)">Ver todas</a></small></h2><div class="list">${lastReps.map(x => `<a class="it" href="${plLink('', x.tuser)}"><span class="av g">${ini(x.target_name)}</span><span class="tx"><b>${escH(x.target_name)}</b><small>${escH(x.why || '—')} · ${agoES(x.ts)}</small></span>${ic('chev')}</a>`).join('') || '<p class="none">Ninguna.</p>'}</div></div>`;
}

/* ---------- Jugadores ---------- */
async function admPlayers(qs) {
  const pl = await playersFind(qs);
  return `<form class="srch" method="get" action="/admin"><input type="hidden" name="t" value="players"><input name="q" value="${escH(qs)}" placeholder="Apodo, cuenta, ID o código" autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="search"><button class="btn gold">Buscar</button></form>
<div class="card"><h2>${ic('users')}${qs ? 'Resultados' : 'Vistos hace poco'}<small>${fmtN(pl.total)} móviles · ${fmtN(pl.accts)} cuentas</small></h2><div class="list">
${pl.rows.map(x => { const nm = x.pname || x.name || 'Sin apodo', ban = banWhy(x.dev, x.pname || x.name, x.usr);
  return `<a class="it" href="${plLink(x.dev, x.usr)}"><span class="av${ban ? ' r' : x.usr ? '' : ' g'}">${ini(nm)}</span><span class="tx"><b>${escH(nm)}${x.usr && x.usr.toLowerCase() !== String(nm).toLowerCase() ? `<span class="chip">${escH(x.usr)}</span>` : x.usr ? '<span class="chip">cuenta</span>' : ''}${ban ? '<span class="chip r">BANEADO</span>' : ''}</b><small>${x.trophies != null ? fmtN(x.trophies) + ' trofeos · ' : ''}${x.ver ? escH(x.ver) + ' · ' : ''}${x.last_ms ? agoES(x.last_ms) : 'sin abrir con esta versión'}${x.dev ? ' · ' + escH(x.dev) : ''}</small></span>${ic('chev')}</a>`; }).join('') || `<p class="none">${qs ? 'Nadie con eso.' : 'Aún no hay jugadores apuntados (salen cuando abren el juego).'}</p>`}
</div>${pl.rows.length >= 100 ? '<p class="hint">Salen los 100 más recientes: busca para encontrar a alguien concreto.</p>' : ''}</div>`;
}

/* ---------- Ficha ---------- */
function admPlayerPage(P, sub) {
  const A = P.acc, nm = (A && A.name) || P.names[0] || 'Sin apodo', back = plLink(P.dev, A ? A.username : '');
  const bk = s => back + '&s=' + s;
  const banned = P.live.length > 0 || !!P.seenBan;
  const tgt = { pdev: P.dev, pusr: A ? A.username : '' };
  const hero = `<div class="card"><div class="hero"><span class="av${banned ? ' r' : A ? '' : ' g'}">${ini(nm)}</span><div class="tx"><h2>${escH(nm)}</h2><small>${A ? `cuenta <span class="acc">${escH(A.username)}</span>` : 'sin cuenta'}${P.devs[0] ? ' · ' + escH(P.devs[0].dev) : ''}</small></div></div>
<div class="kv">${A ? `<div><span>Trofeos</span><b>${A.trophies != null ? fmtN(A.trophies) : '—'}</b></div><div><span>Código de amigo</span><b>${escH(A.code || '—')}</b></div><div><span>Cuenta creada</span><b>${whenES(A.created_ms)}</b></div><div><span>Última vez</span><b>${agoES(A.seen_ms)}</b></div>` : ''}<div><span>Móviles</span><b>${P.devs.length}</b></div><div><span>Apodos usados</span><b>${P.names.map(escH).join(', ') || '—'}</b></div></div>
${P.live.length ? P.live.map(([k, b]) => `<div class="state r">${ic('ban')}<span class="tx"><b>Baneado · ${escH(k)}</b><small>${escH(b.reason || 'Sin motivo')} · ${banLeft(b)}</small></span>${b.by === 'BANNED' ? '<small>en BANNED</small>' : `<form method="post" action="/admin">${hidF('unban', bk('ban'), { target: k })}<button class="btn sm">Quitar</button></form>`}</div>`).join('')
  : P.seenBan ? `<div class="state r">${ic('ban')}<span class="tx"><b>Baneado</b><small>por otro ID o apodo que usó este móvil</small></span></div>` : `<div class="state">${ic('dot')}No está baneado</div>`}</div>`;
  const S = [['ban', 'Banear'], ['name', 'Apodo'], ['gift', 'Regalo'], ['trophy', 'Trofeos'], ['info', 'Actividad']];
  const seg = `<div class="seg">${S.map(([k, l]) => `<a href="${bk(k)}" class="${sub === k ? 'on' : ''}">${l}</a>`).join('')}</div>`;
  const opts = [A && [A.username, 'Cuenta ' + A.username + ' (todos sus móviles)'], ...P.devs.map(d => [d.dev, 'Móvil ' + d.dev]), ...P.names.map(n => [n, 'Apodo ' + n])].filter(Boolean);
  const who = A ? 'Le llega a su cuenta, en el primer móvil donde abra el juego con la sesión iniciada.' : `Le llega a este móvil (${escH(P.devs[0] ? P.devs[0].dev : P.dev)}) la próxima vez que abra el juego.`;
  let body = '';
  if (sub === 'ban') body = `<form class="card" method="post" action="/admin">${hidF('ban', bk('ban'), tgt)}<h2>${ic('ban')}Banear</h2>
<label>A quién</label><select name="target">${opts.map(([v, l]) => `<option value="${escH(v)}">${escH(l)}</option>`).join('')}</select>
<label>Duración</label><select name="hours">${HOURS}</select>
<label>Motivo (lo verá en el juego)</label><input name="reason" maxlength="120" placeholder="Insultos, trampas…"><button class="btn red">${ic('ban')}Banear</button></form>
<div class="card"><h2>${ic('ban')}Historial de baneos<small>${P.blog.length}</small></h2><div class="list">${P.blog.map(x => `<div class="it"><span class="av ${x.action === 'ban' ? 'r' : 'g'}">${ic(x.action === 'ban' ? 'ban' : 'dot')}</span><span class="tx"><b>${x.action === 'ban' ? 'Baneo' : 'Desbaneo'} · ${escH(x.target)}</b><small>${x.action === 'ban' ? (Number(x.hours) ? Number(x.hours) + ' h' : 'para siempre') + ' · ' + escH(x.reason || 'sin motivo') + ' · ' : ''}${whenES(x.ts)}</small></span></div>`).join('') || '<p class="none">Sin baneos registrados.</p>'}</div></div>`;
  if (sub === 'name') body = `<form class="card" method="post" action="/admin">${hidF('rename', bk('name'), tgt)}<h2>${ic('users')}Cambiar apodo</h2>
<p class="hint" style="margin-top:0">Ahora se llama <b style="color:#fff">${escH(nm)}</b>. El apodo actual queda bloqueado para que nadie pueda volver a ponérselo.</p>
<label>Apodo nuevo (déjalo vacío para que elija otro él)</label><input name="newname" maxlength="10" autocomplete="off" spellcheck="false" placeholder="Vacío = tiene que elegir otro">
<label>Motivo (lo verá en el juego)</label><input name="msg" maxlength="100" placeholder="Tu apodo no está permitido">
<button class="btn gold">${ic('users')}Cambiar apodo</button><p class="hint">Le sale un aviso al abrir el juego. ${A ? 'Vale para todos sus móviles.' : 'Le llega a este móvil.'}</p></form>`;
  if (sub === 'gift') body = `<form class="card" method="post" action="/admin">${hidF('gift', bk('gift'), tgt)}<h2>${ic('gift')}Dar monedas o gemas</h2>
<div class="two"><div><label>Monedas</label><input name="coins" type="number" min="0" max="1000000" inputmode="numeric" placeholder="0"></div><div><label>Gemas</label><input name="gems" type="number" min="0" max="100000" inputmode="numeric" placeholder="0"></div></div>
<label>Mensaje (opcional)</label><input name="msg" maxlength="100" placeholder="¡Gracias por jugar!"><button class="btn gold">${ic('gift')}Enviar regalo</button><p class="hint">${who}</p></form>${admGiftList(P.gifts)}`;
  if (sub === 'trophy') body = `<form class="card" method="post" action="/admin">${hidF('trophy', bk('trophy'), tgt)}<h2>${ic('trophy')}Corregir trofeos</h2>
<p class="hint" style="margin-top:0">${A && A.trophies != null ? `Ahora tiene <b style="color:#fff">${fmtN(A.trophies)}</b> trofeos (el último dato que mandó su juego).` : 'Sin cuenta no vemos sus trofeos.'}</p>
<label>Sumar o quitar (pon − delante para quitar)</label><input name="trophies" type="number" min="-100000" max="100000" inputmode="numeric" placeholder="-200 o 150">
<label>Mensaje (lo verá al abrir el juego)</label><input name="msg" maxlength="100" placeholder="Trofeos ganados con trampas"><button class="btn gold">${ic('trophy')}Corregir trofeos</button><p class="hint">Le sale un aviso como el del regalo. Nunca bajan de 0. ${who}</p></form>${admGiftList(P.gifts)}`;
  if (sub === 'info') body = `<a class="card it" style="padding:14px 16px" href="${admUrl('matches', { q: A ? A.username : P.dev })}"><span class="av b">${ic('swords')}</span><span class="tx"><b>Sus combates en línea</b><small>últimos 30 días</small></span>${ic('chev')}</a><div class="card"><h2>${ic('users')}Móviles<small>${P.devs.length}</small></h2><div class="list">${P.devs.map(d => `<div class="it"><span class="av g">${ic('dot')}</span><span class="tx"><b>${escH(d.dev)}</b><small>${d.name ? 'apodo ' + escH(d.name) + ' · ' : ''}${d.ver ? escH(d.ver) + ' · ' : ''}${d.last_ms ? 'última vez ' + agoES(d.last_ms) + ' · abierto ' + d.opens + (d.opens == 1 ? ' vez' : ' veces') : 'sin datos de apertura'}</small></span></div>`).join('') || '<p class="none">Ninguno.</p>'}</div></div>
${A ? `<div class="card"><h2>${ic('users')}Club</h2>${P.club ? `<div class="it"><span class="av b">${ini(P.club.name)}</span><span class="tx"><b>${escH(P.club.name)}</b><small>${P.club.role === 'owner' ? 'líder' : 'miembro'} · ${P.club.n} ${P.club.n == 1 ? 'miembro' : 'miembros'}</small></span></div>` : '<p class="none">No está en ningún club.</p>'}</div>
<div class="card"><h2>${ic('users')}Amigos<small>${P.friends.filter(f => f.ok).length}</small></h2><div class="list">${P.friends.map(f => `<a class="it" href="${admUrl('players', { q: f.code })}"><span class="av g">${ini(f.name)}</span><span class="tx"><b>${escH(f.name)}${f.ok ? '' : '<span class="chip y">pendiente</span>'}</b><small>${escH(f.code)} · ${fmtN(f.trophies)} trofeos</small></span>${ic('chev')}</a>`).join('') || '<p class="none">Ninguno.</p>'}</div></div>
<div class="card"><h2>${ic('flag')}Denuncias recibidas<small>${P.repIn.length}</small></h2><div class="list">${P.repIn.map(x => `<div class="it"><span class="av r">${ic('flag')}</span><span class="tx"><b>${escH(x.why || '—')}</b><small>se llamaba ${escH(x.target_name)} · denunciado por ${escH(x.other || '?')} · ${whenES(x.ts)}</small></span></div>`).join('') || '<p class="none">Ninguna.</p>'}</div></div>
<div class="card"><h2>${ic('flag')}Denuncias hechas<small>${P.repOut.length}</small></h2><div class="list">${P.repOut.map(x => `<div class="it"><span class="av g">${ic('flag')}</span><span class="tx"><b>${escH(x.other || x.target_name)}</b><small>${escH(x.why || '—')} · ${whenES(x.ts)}</small></span></div>`).join('') || '<p class="none">Ninguna.</p>'}</div></div>` : ''}`;
  return hero + seg + body;
}
function admGiftList(gifts) {
  return `<div class="card"><h2>${ic('gift')}Regalos y correcciones<small>${gifts.length}</small></h2><div class="list">${gifts.map(g => { const t = Number(g.trophies) || 0, c = Number(g.coins) || 0, gm = Number(g.gems) || 0;
    const what = [g.rename != null ? (g.rename ? 'Apodo → ' + escH(g.rename) : 'Apodo quitado') : '', c ? fmtN(c) + ' monedas' : '', gm ? fmtN(gm) + ' gemas' : '', t ? (t > 0 ? '+' : '−') + fmtN(Math.abs(t)) + ' trofeos' : ''].filter(Boolean).join(' · ') || 'nada';
    return `<div class="it"><span class="av${t < 0 && !c && !gm ? ' r' : ''}">${ic(t && !c && !gm ? 'trophy' : 'gift')}</span><span class="tx"><b>${what}${g.cl ? '<span class="chip g">recogido</span>' : '<span class="chip y">pendiente</span>'}</b><small>${escH(g.msg || 'Sin mensaje')} · ${whenES(g.ts)}${g.who ? ' · ' + escH(g.who) : ''}</small></span></div>`; }).join('') || '<p class="none">Ninguno.</p>'}</div></div>`;
}

/* ---------- Baneos ---------- */
async function admBans(pre) {
  const live = [...bans.entries()].filter(([, b]) => banLive(b)).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  let log = []; try { log = await q(`select target, action, hours, reason, by_who, ${msOf('created')} as ts from ban_log order by created desc limit 40`); } catch (e) {}
  return `<form class="card" method="post" action="/admin">${hidF('ban', admUrl('bans'))}<h2>${ic('ban')}Banear</h2>
<label>A quién: cuenta, ID (MF-…) o apodo</label><input name="target" required value="${escH(pre || '')}" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="MF-9HBYUE8D">
<div class="two"><div><label>Duración</label><select name="hours">${HOURS}</select></div><div><label>Motivo</label><input name="reason" maxlength="120" placeholder="Insultos…"></div></div>
<button class="btn red">${ic('ban')}Banear</button><p class="hint">Más fácil: busca al jugador en <a href="${admUrl('players')}" style="color:var(--gold)">Jugadores</a> y banéalo desde su ficha.</p></form>
<div class="card"><h2>${ic('ban')}Baneados ahora<small>${live.length}</small></h2><div class="list">${live.map(([t, b]) => `<div class="it"><a class="av r" href="${admUrl('players', { q: t })}" style="text-decoration:none">${ini(t)}</a><span class="tx"><b>${escH(t)}</b><small>${escH(b.reason || 'Sin motivo')} · ${banLeft(b)}${b.by && b.by !== 'admin' ? ' · ' + escH(b.by) : ''}</small></span>${b.by === 'BANNED' ? '<small>en BANNED</small>' : `<form method="post" action="/admin" style="margin:0">${hidF('unban', admUrl('bans'), { target: t })}<button class="btn sm">Quitar</button></form>`}</div>`).join('') || '<p class="none">Nadie.</p>'}</div></div>
<div class="card"><h2>${ic('ban')}Historial<small>últimos 40</small></h2><div class="list">${log.map(x => `<a class="it" href="${admUrl('players', { q: x.target })}"><span class="av ${x.action === 'ban' ? 'r' : 'g'}">${ic(x.action === 'ban' ? 'ban' : 'dot')}</span><span class="tx"><b>${x.action === 'ban' ? 'Baneo' : 'Desbaneo'} · ${escH(x.target)}</b><small>${x.action === 'ban' ? (Number(x.hours) ? Number(x.hours) + ' h' : 'para siempre') + ' · ' + escH(x.reason || 'sin motivo') + ' · ' : ''}${escH(x.by_who)} · ${whenES(x.ts)}</small></span>${ic('chev')}</a>`).join('') || '<p class="none">Vacío (se apunta desde el servidor v292).</p>'}</div></div>
<p class="hint">${dbReady ? 'Los baneos se guardan en la base de datos.' : 'Sin base de datos: los baneos se pierden si el servidor se reinicia.'}</p>`;
}

/* ---------- Regalos ---------- */
async function admGifts() {
  let gl = [], ind = [];
  try { gl = await q(`select g.id, g.coins, g.gems, g.msg, ${msOf('g.created')} as ts, ${msOf('g.until')} as until_ms, (select count(*)::int from gift_all_claims c where c.gift = g.id and c.who like 'D:%') as n from gift_all g order by g.created desc limit 10`); } catch (e) {}
  try { ind = await q(`select g.coins, g.gems, g.trophies, g.msg, ${msOf('g.created')} as ts, ${msOf('g.claimed_at')} as cl, coalesce(a.username, nullif(g.target_dev, '')) as who from gifts g left join accounts a on a.id = g.target_acct order by g.created desc limit 25`); } catch (e) {}
  return `<form class="card" method="post" action="/admin">${hidF('giftall', admUrl('gifts'))}<h2>${ic('gift')}Regalo para todos</h2>
<div class="two"><div><label>Monedas</label><input name="coins" type="number" min="0" max="100000" inputmode="numeric" placeholder="0"></div><div><label>Gemas</label><input name="gems" type="number" min="0" max="10000" inputmode="numeric" placeholder="0"></div></div>
<label>Mensaje (lo verán todos)</label><input name="msg" maxlength="100" placeholder="¡Gracias por jugar! Feliz Navidad">
<label>Activo durante</label><select name="days"><option value="1">1 día</option><option value="3">3 días</option><option value="7" selected>7 días</option><option value="14">14 días</option><option value="30">30 días</option></select>
<button class="btn gold" onclick="return confirm('¿Mandar este regalo a TODOS los jugadores?')">${ic('gift')}Enviar a todos</button>
<p class="hint">Le llega una vez a cada móvil o cuenta que abra el juego mientras esté activo, también a los que se instalen esos días.</p></form>
${gl.length ? `<div class="card"><h2>${ic('gift')}Regalos para todos<small>${gl.length}</small></h2><div class="list">${gl.map(g => { const on = Number(g.until_ms) > Date.now();
  return `<div class="it"><span class="av${on ? '' : ' g'}">${ic('gift')}</span><span class="tx"><b>${fmtN(g.coins)} monedas · ${fmtN(g.gems)} gemas${on ? '<span class="chip g">activo</span>' : ''}</b><small>${escH(g.msg || 'Sin mensaje')} · ${on ? 'hasta ' + whenES(g.until_ms) : 'terminó ' + whenES(g.until_ms)} · recogido por ${fmtN(g.n)}</small></span>${on ? `<form method="post" action="/admin" style="margin:0">${hidF('giftall_end', admUrl('gifts'), { id: g.id })}<button class="btn sm" onclick="return confirm('¿Terminar este regalo? Quien no lo haya recogido ya no lo recibirá.')">Terminar</button></form>` : ''}</div>`; }).join('')}</div></div>` : ''}
<form class="card" method="post" action="/admin">${hidF('gift1', admUrl('gifts'))}<h2>${ic('users')}A un jugador</h2>
<label>Cuenta o ID del móvil (MF-…)</label><input name="who" required autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="Ana9812 o MF-9HBYUE8D">
<div class="three"><div><label>Monedas</label><input name="coins" type="number" min="0" max="1000000" inputmode="numeric" placeholder="0"></div><div><label>Gemas</label><input name="gems" type="number" min="0" max="100000" inputmode="numeric" placeholder="0"></div><div><label>Trofeos ±</label><input name="trophies" type="number" min="-100000" max="100000" inputmode="numeric" placeholder="0"></div></div>
<label>Mensaje (opcional)</label><input name="msg" maxlength="100" placeholder="¡Gracias por jugar!"><button class="btn gold">${ic('gift')}Enviar</button></form>
${admGiftList(ind)}`;
}

/* ---------- Denuncias ---------- */
async function admReports() {
  let reps = []; try { reps = await q(`select r.target_name, r.why, ${msOf('r.created')} as ts, ta.username as tuser, ba.username as buser from reports r left join accounts ta on ta.id = r.target left join accounts ba on ba.id = r.by_who order by r.created desc limit 60`); } catch (e) {}
  const cnt = {}; for (const r of reps) if (r.tuser) cnt[r.tuser] = (cnt[r.tuser] || 0) + 1;
  return `<div class="card"><h2>${ic('flag')}Denuncias de amigos<small>últimas ${reps.length}</small></h2><div class="list">${reps.map(x => `<a class="it" href="${plLink('', x.tuser)}"><span class="av${cnt[x.tuser] > 2 ? ' r' : ' g'}">${ini(x.target_name)}</span><span class="tx"><b>${escH(x.tuser || x.target_name)}${cnt[x.tuser] > 1 ? `<span class="chip r">${cnt[x.tuser]} denuncias</span>` : ''}</b><small>${escH(x.why || '—')} · se llamaba ${escH(x.target_name)} · por ${escH(x.buser || '?')} · ${agoES(x.ts)}</small></span>${ic('chev')}</a>`).join('') || '<p class="none">Ninguna.</p>'}</div>
<p class="hint">Toca una para abrir la ficha del denunciado y banearlo desde allí. Quien denuncia también lo bloquea.</p></div>`;
}

/* ---------- Más (v298): Juego (aviso y mantenimiento) · Códigos · Clubs · Combates ---------- */
const MAS = [['game', 'Juego', 'Aviso al abrir y mantenimiento', 'megaphone'], ['promos', 'Códigos', 'Códigos promocionales', 'ticket'], ['clubs', 'Clubs', 'Renombrar, borrar y expulsar', 'shield'], ['matches', 'Combates', 'Combates en línea recientes', 'swords']];
function admMore() {
  const st = [maintOn() ? '<span class="chip r" style="margin:0 6px 0 0">MANTENIMIENTO</span>' : '', noticeNow() ? '<span class="chip y" style="margin:0">aviso activo</span>' : ''].join('');
  return `<div class="card"><div class="list">${MAS.map(([t, l, d, i]) => `<a class="it" href="${admUrl(t)}"><span class="av b">${ic(i)}</span><span class="tx"><b>${l}</b><small>${t === 'game' && st ? st.replace(/margin-left:6px/g, '') : d}</small></span>${ic('chev')}</a>`).join('')}</div></div>`;
}
const DAYS = (sel, never) => `${never ? `<option value="0"${sel === 0 ? ' selected' : ''}>${never}</option>` : ''}${[1, 3, 7, 14, 30].map(d => `<option value="${d}"${sel === d ? ' selected' : ''}>${d} ${d == 1 ? 'día' : 'días'}</option>`).join('')}`;
function admGame() {
  const M = SET.maint || {}, N = noticeNow(), back = admUrl('game');
  return `<form class="card" method="post" action="/admin">${hidF('maint_set', back)}<h2>${ic('wrench')}Modo mantenimiento${M.on ? '<small><span class="chip r">ACTIVADO</span></small>' : ''}</h2>
${M.on ? `<div class="state r">${ic('wrench')}<span class="tx"><b>Nadie puede buscar partida en línea</b><small>${escH(M.msg || 'Sin mensaje')}</small></span></div>` : ''}
<label>Mensaje que verán al darle a jugar en línea</label><input name="msg" maxlength="120" value="${escH(M.msg || '')}" placeholder="Estamos mejorando el juego. Vuelve en un rato.">
${M.on ? `<input type="hidden" name="on" value="0"><button class="btn">${ic('wrench')}Desactivar mantenimiento</button>` : `<input type="hidden" name="on" value="1"><button class="btn red" onclick="return confirm('¿Activar el mantenimiento? Nadie podrá jugar en línea hasta que lo quites.')">${ic('wrench')}Activar mantenimiento</button>`}
<p class="hint">Solo bloquea el modo en línea: contra bots se sigue jugando. Los combates que ya estén en marcha terminan normal. Con el juego v3.0.6 o más nuevo también sale un aviso al abrir.</p></form>
<form class="card" method="post" action="/admin">${hidF('notice_set', back)}<h2>${ic('megaphone')}Aviso al abrir el juego${N ? '<small><span class="chip g">activo</span></small>' : ''}</h2>
${N ? `<div class="state">${ic('megaphone')}<span class="tx"><b>${escH(N.title || 'Aviso')}</b><small>${escH(N.text)} · ${N.until ? 'hasta ' + whenES(N.until) : 'sin fecha de fin'}</small></span></div>` : ''}
<label>Título</label><input name="title" maxlength="40" placeholder="¡Novedades!">
<label>Texto</label><textarea name="text" maxlength="300" rows="3" placeholder="Hay nuevas bolas en la tienda…"></textarea>
<label>Activo durante</label><select name="days">${DAYS(3, 'Sin fecha de fin')}</select>
<button class="btn gold">${ic('megaphone')}${N ? 'Cambiar el aviso' : 'Publicar aviso'}</button>
<p class="hint">Le sale una sola vez a cada jugador, cuando abre el juego y no está en un combate. Si lo cambias, vuelve a salir a todos.</p></form>
${N ? `<form class="card" method="post" action="/admin" style="padding:12px 16px">${hidF('notice_clear', back)}<button class="btn" style="margin:0">Quitar el aviso</button></form>` : ''}`;
}
async function admPromos() {
  const rows = await q(`select code, coins, gems, max_uses, uses, msg, active, ${msOf('until')} as until_ms, ${msOf('created')} as ts from promos order by created desc limit 50`);
  return `<form class="card" method="post" action="/admin">${hidF('promo_new', admUrl('promos'))}<h2>${ic('ticket')}Crear código</h2>
<label>Código (letras y números, sin espacios)</label><input name="code" required maxlength="24" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="NAVIDAD25" style="text-transform:uppercase">
<div class="two"><div><label>Monedas</label><input name="coins" type="number" min="0" max="100000" inputmode="numeric" placeholder="0"></div><div><label>Gemas</label><input name="gems" type="number" min="0" max="10000" inputmode="numeric" placeholder="0"></div></div>
<div class="two"><div><label>Usos máximos (0 = sin límite)</label><input name="max" type="number" min="0" max="1000000" inputmode="numeric" placeholder="0"></div><div><label>Caduca en</label><select name="days">${DAYS(0, 'Nunca')}</select></div></div>
<label>Mensaje (lo verá al canjearlo)</label><input name="msg" maxlength="100" placeholder="¡Feliz Navidad!">
<button class="btn gold">${ic('ticket')}Crear código</button><p class="hint">Cada cuenta y cada móvil puede canjear un código una sola vez. Se canjea en el juego en Ajustes → Canjear código (v3.0.6 o más nuevo).</p></form>
<div class="card"><h2>${ic('ticket')}Códigos<small>${rows.length}</small></h2><div class="list">${rows.map(r => { const late = r.until_ms && Number(r.until_ms) < Date.now(), full = r.max_uses > 0 && r.uses >= r.max_uses, on = r.active && !late && !full;
  return `<div class="it"><span class="av${on ? '' : ' g'}">${ic('ticket')}</span><span class="tx"><b>${escH(r.code)}${on ? '<span class="chip g">activo</span>' : !r.active ? '<span class="chip">pausado</span>' : late ? '<span class="chip r">caducado</span>' : '<span class="chip y">agotado</span>'}</b><small>${[r.coins ? fmtN(r.coins) + ' monedas' : '', r.gems ? fmtN(r.gems) + ' gemas' : ''].filter(Boolean).join(' · ') || 'nada'} · ${fmtN(r.uses)}${r.max_uses ? ' / ' + fmtN(r.max_uses) : ''} usos${r.until_ms ? ' · ' + (late ? 'caducó ' : 'hasta ') + whenES(r.until_ms) : ''}${r.msg ? ' · ' + escH(r.msg) : ''}</small></span><form method="post" action="/admin">${hidF('promo_toggle', admUrl('promos'), { code: r.code })}<button class="btn sm">${r.active ? 'Pausar' : 'Activar'}</button></form></div>`; }).join('') || '<p class="none">Ninguno todavía.</p>'}</div></div>`;
}
async function admClubs(qs) {
  const s = String(qs || '').trim().toLowerCase().replace(/[%_]/g, '').slice(0, 20);
  const rows = await q(`select c.id, c.name, c.descr, ${msOf('c.created')} as ts, po.name as owner_name, count(m.acct)::int as n, coalesce(sum(p.trophies), 0)::int as tr
    from clubs c left join club_members m on m.club = c.id left join players p on p.id = m.acct left join players po on po.id = c.owner
    where ($1 = '' or c.name_lc like '%' || $1 || '%') group by c.id, po.name order by tr desc, c.id limit 100`, [s]);
  return `<form class="srch" method="get" action="/admin"><input type="hidden" name="t" value="clubs"><input name="q" value="${escH(qs || '')}" placeholder="Nombre del club" autocomplete="off" spellcheck="false" enterkeyhint="search"><button class="btn gold">Buscar</button></form>
<div class="card"><h2>${ic('shield')}${s ? 'Resultados' : 'Clubs'}<small>${rows.length}${rows.length >= 100 ? '+' : ''}</small></h2><div class="list">${rows.map(r => `<a class="it" href="${admUrl('club', { id: r.id })}"><span class="av b">${ini(r.name)}</span><span class="tx"><b>${escH(r.name)}</b><small>${r.n} ${r.n == 1 ? 'miembro' : 'miembros'} · ${fmtN(r.tr)} trofeos · líder ${escH(r.owner_name || '?')}</small></span>${ic('chev')}</a>`).join('') || `<p class="none">${s ? 'Ningún club con ese nombre.' : 'Aún no hay clubs.'}</p>`}</div></div>`;
}
async function admClub(id) {
  const c = (await q(`select id, name, descr, owner, ${msOf('created')} as ts from clubs where id = $1`, [id]))[0];
  if (!c) return `<div class="card"><p class="none">Ese club ya no existe.</p></div>`;
  const mem = await q(`select p.id, p.name, p.trophies, a.username, m.role from club_members m join players p on p.id = m.acct left join accounts a on a.id = p.id order by (m.role = 'owner') desc, p.trophies desc`.replace('order by', 'where m.club = $1 order by'), [id]);
  const msgs = await q(`select id, name, text, ${msOf('created')} as ts from club_msgs where club = $1 order by id desc limit 20`, [id]);
  const back = admUrl('club', { id });
  return `<div class="card"><div class="hero"><span class="av b">${ini(c.name)}</span><div class="tx"><h2>${escH(c.name)}</h2><small>${escH(c.descr || 'Sin descripción')} · creado ${whenES(c.ts)}</small></div></div></div>
<form class="card" method="post" action="/admin">${hidF('club_rename', back, { id })}<h2>${ic('shield')}Cambiar nombre</h2><label>Nombre nuevo</label><input name="name" maxlength="20" required autocomplete="off" spellcheck="false" placeholder="${escH(c.name)}"><button class="btn gold">Cambiar nombre</button></form>
<div class="card"><h2>${ic('users')}Miembros<small>${mem.length}</small></h2><div class="list">${mem.map(x => `<div class="it"><a class="av${x.role === 'owner' ? '' : ' g'}" href="${plLink('', x.username || '')}" style="text-decoration:none">${ini(x.name)}</a><span class="tx"><b>${escH(x.name)}${x.role === 'owner' ? '<span class="chip y">líder</span>' : ''}</b><small>${x.username ? escH(x.username) + ' · ' : ''}${fmtN(x.trophies)} trofeos</small></span><form method="post" action="/admin">${hidF('club_kick', back, { id, acct: x.id })}<button class="btn sm" onclick="return confirm('¿Expulsar a ${escH(x.name).replace(/'/g, '')} del club?')">Expulsar</button></form></div>`).join('') || '<p class="none">Sin miembros.</p>'}</div></div>
<div class="card"><h2>${ic('chat')}Chat<small>últimos ${msgs.length}</small></h2><div class="list">${msgs.map(x => `<div class="it"><span class="tx"><b>${escH(x.name)}</b><small style="color:var(--txt)">${escH(x.text)}</small><small>${agoES(x.ts)}</small></span><form method="post" action="/admin">${hidF('club_msgdel', back, { id, msg: x.id })}<button class="btn sm">Borrar</button></form></div>`).join('') || '<p class="none">Sin mensajes.</p>'}</div></div>
<form class="card" method="post" action="/admin">${hidF('club_del', admUrl('clubs'), { id })}<h2>${ic('ban')}Borrar club</h2><p class="hint" style="margin-top:0">Se borra el club y su chat; los miembros se quedan sin club.</p><button class="btn red" onclick="return confirm('¿Borrar el club ${escH(c.name).replace(/'/g, '')} para siempre?')">Borrar club</button></form>`;
}
const CARDN = { vida: 'Vida', dano: 'Daño', velocidad: 'Velocidad', giro: 'Giro', peso: 'Peso', alcance: 'Alcance', vampiro: 'Vampiro', critico: 'Crítico', regen: 'Regeneración', furia: 'Furia', coraza: 'Coraza' };
const cardES = c => { const [id, lv] = String(c).split(' '); return (CARDN[id] || id) + (lv ? ' nv ' + lv : ''); };
const RSN = { fin: '', quit: 'se rindió', stall: 'se colgó', 'desconexión': 'desconexión', timeout: 'tiempo agotado' };
async function admMatches(qs) {
  const s = String(qs || '').trim().toLowerCase().replace(/[%_]/g, '').slice(0, 24);
  const rows = await q(`select kind, winner, reason, dur, a_name, a_dev, a_user, a_tr, a_card, b_name, b_dev, b_user, b_tr, b_card, ${msOf('created')} as ts from matches
    where ($1 = '' or lower(a_name) like '%' || $1 || '%' or lower(b_name) like '%' || $1 || '%' or lower(a_dev) = $1 or lower(b_dev) = $1 or lower(a_user) = $1 or lower(b_user) = $1)
    order by created desc limit 80`, [s]);
  const tot = (await q(`select count(*)::int as n, count(*) filter (where created > now() - interval '24 hours')::int as d1 from matches`))[0];
  const side = (r, k) => { const w = r.winner === k, nm = r[k.toLowerCase() + '_name'] || 'Jugador', u = r[k.toLowerCase() + '_user'], d = r[k.toLowerCase() + '_dev'], cd = r[k.toLowerCase() + '_card'];
    return `<a href="${plLink(d || '', u || '')}" class="mside${w ? ' w' : ''}"><b>${w ? '🏆 ' : ''}${escH(nm)}</b><small>${fmtN(r[k.toLowerCase() + '_tr'])} trofeos${cd ? ' · ' + escH(cardES(cd)) : ''}</small></a>`; };
  return `<form class="srch" method="get" action="/admin"><input type="hidden" name="t" value="matches"><input name="q" value="${escH(qs || '')}" placeholder="Apodo, cuenta o ID" autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="search"><button class="btn gold">Buscar</button></form>
<div class="card"><h2>${ic('swords')}${s ? 'Combates de ' + escH(qs) : 'Últimos combates'}<small>${fmtN(tot.d1)} hoy · ${fmtN(tot.n)} en 30 días</small></h2><div class="list">${rows.map(r => `<div class="mrow"><div class="mhead"><span class="chip${r.kind === 'normal' ? ' g' : ''}" style="margin:0">${r.kind === 'normal' ? 'Amistoso' : 'Competitivo'}</span><small>${agoES(r.ts)} · ${r.dur >= 60 ? (r.dur / 60 | 0) + ' min ' : ''}${r.dur % 60} s${RSN[r.reason] ? ' · ' + RSN[r.reason] : r.reason && RSN[r.reason] == null ? ' · ' + escH(r.reason) : ''}${!r.winner ? ' · sin ganador' : ''}</small></div><div class="mvs">${side(r, 'A')}<span class="vs">VS</span>${side(r, 'B')}</div></div>`).join('') || `<p class="none">${s ? 'Ningún combate de ese jugador.' : 'Aún no hay combates apuntados (se apuntan desde el servidor v298).'}</p>`}</div>${rows.length >= 80 ? '<p class="hint">Salen los 80 más recientes. Se guardan 30 días.</p>' : ''}</div>`;
}

/* ---------- acciones (POST) ---------- */
async function admGiftTo(acct, dev, coins, gems, tr, gmsg) {
  await q('insert into gifts (target_acct, target_dev, coins, gems, trophies, msg) values ($1, $2, $3, $4, $5, $6)', [acct, acct ? '' : dev, coins, gems, tr, gmsg]);
  giftPend.add(acct ? 'A:' + acct : 'D:' + dev);
}
async function admAction(f) {
  const a = f.get('a'), num = (k, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(f.get(k)) || 0))), txt = (k, n) => String(f.get(k) || '').replace(/[<>&"]/g, '').trim().slice(0, n);
  const who = async () => { const pusr = f.get('pusr') || '', pdev = String(f.get('pdev') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
    if (pusr) { const x = (await q('select id from accounts where user_lc = $1', [pusr.toLowerCase()]))[0]; if (x) return { acct: x.id, dev: '', name: pusr }; }
    return { acct: '', dev: pdev, name: pdev }; };
  if (a === 'ban') { const t = f.get('target'), h = Number(f.get('hours')) || 0; const b = await banAdd(t, h, f.get('reason'), 'admin'); return b ? [`Baneado: ${String(t).trim().toUpperCase()} · ${h ? h + ' h' : 'para siempre'}`] : ['Falta a quién banear.', 1]; }
  if (a === 'unban') { await banDel(f.get('target')); return [`Baneo quitado: ${f.get('target')}`]; }
  if (!dbReady) return ['La base de datos no está lista.', 1];
  if (a === 'gift' || a === 'trophy' || a === 'gift1') {
    let W;
    if (a === 'gift1') { const raw = String(f.get('who') || '').trim(); const x = (await q('select id, username from accounts where user_lc = $1', [raw.toLowerCase()]))[0];
      if (x) W = { acct: x.id, dev: '', name: x.username }; else if (/^MF-[A-Z0-9]{4,}$/i.test(raw)) W = { acct: '', dev: raw.toUpperCase(), name: raw.toUpperCase() }; else return [`No hay ninguna cuenta «${raw}». Usa el usuario de la cuenta o el ID (MF-…).`, 1]; }
    else W = await who();
    if (!W.acct && !W.dev) return ['No sé a quién mandarlo.', 1];
    const coins = a === 'trophy' ? 0 : num('coins', 0, 1e6), gems = a === 'trophy' ? 0 : num('gems', 0, 1e5), tr = a === 'gift' ? 0 : num('trophies', -1e5, 1e5), gmsg = txt('msg', 100);
    if (!coins && !gems && !tr) return [a === 'trophy' ? 'Pon cuántos trofeos sumar o quitar.' : 'Pon alguna cantidad.', 1];
    await admGiftTo(W.acct, W.dev, coins, gems, tr, gmsg);
    console.log(`REGALO enviado · ${W.name} · ${coins} monedas, ${gems} gemas, ${tr} trofeos`);
    return [`Enviado a ${W.name}: ${[coins ? fmtN(coins) + ' monedas' : '', gems ? fmtN(gems) + ' gemas' : '', tr ? (tr > 0 ? '+' : '') + tr + ' trofeos' : ''].filter(Boolean).join(', ')}. Le saldrá al abrir el juego.`];
  }
  if (a === 'rename') {
    const W = await who(); if (!W.acct && !W.dev) return ['No sé a quién cambiarle el apodo.', 1];
    let nn = cleanName(f.get('newname') || ''); const gmsg = txt('msg', 100);
    if (nn) { if (nn.length < 3 || nn.toLowerCase() === 'jugador') return ['El apodo nuevo necesita al menos 3 letras.', 1]; if (mfBadName(nn)) return ['Ese apodo nuevo tampoco está permitido.', 1];
      const cur = (await q('select owner from names where name_lc = $1', [nn.toLowerCase()]))[0]; if (cur && cur.owner !== (W.acct || W.dev)) return ['Ese apodo ya lo tiene otro jugador.', 1]; }
    const owner = W.acct || W.dev, olds = new Set();
    for (const x of await q('select name from names where owner = $1', [owner])) olds.add(x.name);
    if (W.acct) { for (const x of await q('select name from players where id = $1', [W.acct])) olds.add(x.name); for (const x of await q('select name from seen where acct_lc = (select user_lc from accounts where id = $1)', [W.acct])) olds.add(x.name); }
    else for (const x of await q('select name from seen where dev = $1', [W.dev])) olds.add(x.name);
    for (const o of olds) { const lc = String(o || '').trim().toLowerCase(); if (lc.length < 3 || lc === 'jugador' || lc === (nn || '').toLowerCase()) continue;
      await q(`insert into names (name_lc, name, owner) values ($1, $2, 'BLOQUEADO') on conflict (name_lc) do update set owner = 'BLOQUEADO', updated = now()`, [lc, String(o).trim()]); nameOwner.set(lc, 'BLOQUEADO'); }
    if (nn) { await q(`insert into names (name_lc, name, owner) values ($1, $2, $3) on conflict (name_lc) do update set name = $2, owner = $3, updated = now()`, [nn.toLowerCase(), nn, owner]); nameOwner.set(nn.toLowerCase(), owner); }
    if (W.acct) await q('update players set name = $2 where id = $1', [W.acct, nn || 'Jugador']).catch(() => {});
    await q('insert into gifts (target_acct, target_dev, rename, msg) values ($1, $2, $3, $4)', [W.acct, W.acct ? '' : W.dev, nn, gmsg]); giftPend.add(W.acct ? 'A:' + W.acct : 'D:' + W.dev);
    console.log(`APODO cambiado · ${W.name} · ${[...olds].join(', ') || '?'} → ${nn || '(elegirá otro)'}`);
    return [nn ? `Apodo cambiado a ${nn}. Le saldrá al abrir el juego.` : 'Apodo quitado: tendrá que elegir otro al abrir el juego.'];
  }
  if (a === 'giftall') {
    const coins = num('coins', 0, 1e5), gems = num('gems', 0, 1e4), days = Math.max(1, Math.min(30, Number(f.get('days')) || 7)), gmsg = txt('msg', 100);
    if (!coins && !gems) return ['Pon alguna moneda o gema.', 1];
    await q(`insert into gift_all (coins, gems, msg, until) values ($1, $2, $3, now() + ($4 || ' days')::interval)`, [coins, gems, gmsg, String(days)]); await gAllLoad();
    console.log(`REGALO PARA TODOS · ${coins} monedas, ${gems} gemas · ${days} días`);
    return [`Regalo para todos enviado: ${fmtN(coins)} monedas y ${fmtN(gems)} gemas durante ${days} ${days == 1 ? 'día' : 'días'}.`];
  }
  if (a === 'giftall_end') { await q('update gift_all set until = now() where id = $1 and until > now()', [Number(f.get('id')) || 0]); await gAllLoad(); return ['Regalo para todos terminado.']; }
  if (a === 'maint_set') { const on = f.get('on') === '1', msg = txt('msg', 120); await setSet('maint', { on, msg }); console.log('MANTENIMIENTO', on ? 'activado' : 'desactivado');
    return [on ? 'Mantenimiento activado: nadie puede buscar partida en línea.' : 'Mantenimiento desactivado.']; }
  if (a === 'notice_set') { const title = txt('title', 40), text = txt('text', 300), days = Math.max(0, Math.min(30, Number(f.get('days')) || 0));
    if (!text) return ['Escribe el texto del aviso.', 1];
    await setSet('notice', { id: Date.now(), title, text, until: days ? Date.now() + days * 864e5 : 0 }); return ['Aviso publicado. Saldrá al abrir el juego.']; }
  if (a === 'notice_clear') { await setSet('notice', null); return ['Aviso quitado.']; }
  if (a === 'promo_new') {
    const code = String(f.get('code') || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24), coins = num('coins', 0, 1e5), gems = num('gems', 0, 1e4), max = num('max', 0, 1e6), days = num('days', 0, 365), msg = txt('msg', 100);
    if (code.length < 3) return ['El código necesita al menos 3 letras o números.', 1];
    if (!coins && !gems) return ['Pon alguna moneda o gema.', 1];
    const r = await q(`insert into promos (code, coins, gems, max_uses, until, msg) values ($1, $2, $3, $4, case when $5::int > 0 then now() + ($5 || ' days')::interval end, $6) on conflict (code) do nothing returning code`, [code, coins, gems, max, days, msg]);
    if (!r.length) return [`El código ${code} ya existe.`, 1];
    console.log(`CÓDIGO creado · ${code} · ${coins} monedas, ${gems} gemas`); return [`Código ${code} creado.`];
  }
  if (a === 'promo_toggle') { const r = await q('update promos set active = not active where code = $1 returning active', [String(f.get('code') || '')]); return r.length ? [r[0].active ? 'Código activado.' : 'Código pausado.'] : ['Ese código no existe.', 1]; }
  if (a.startsWith('club_')) {
    const id = Number(f.get('id')) || 0, c = (await q('select id, name, owner from clubs where id = $1', [id]))[0]; if (!c) return ['Ese club ya no existe.', 1];
    if (a === 'club_rename') {
      const name = cleanTxt(f.get('name'), 20); if (name.length < 3) return ['El nombre necesita al menos 3 letras.', 1]; if (mfBadName(name)) return ['Ese nombre no está permitido.', 1];
      try { await q('update clubs set name = $2, name_lc = $3 where id = $1', [id, name, name.toLowerCase()]); } catch (e) { if (/unique|duplicate/i.test(e.message)) return ['Ya hay otro club con ese nombre.', 1]; throw e; }
      await clubTell(id); console.log(`CLUB renombrado · ${c.name} → ${name}`); return [`Club renombrado a ${name}.`];
    }
    if (a === 'club_del') { const mem = await q('select acct from club_members where club = $1', [id]); await q('delete from clubs where id = $1', [id]);
      for (const r of mem) tell(r.acct, { t: 'cl_ev' }); console.log(`CLUB borrado · ${c.name}`); return [`Club ${c.name} borrado.`]; }
    if (a === 'club_kick') {
      const acct = String(f.get('acct') || ''), mm = (await q('select role from club_members where acct = $1 and club = $2', [acct, id]))[0]; if (!mm) return ['Ya no está en el club.', 1];
      await q('delete from club_members where acct = $1', [acct]);
      if (mm.role === 'owner') { const next = (await q('select acct from club_members where club = $1 order by joined limit 1', [id]))[0];
        if (next) { await q(`update club_members set role = 'owner' where acct = $1`, [next.acct]); await q('update clubs set owner = $2 where id = $1', [id, next.acct]); }
        else { await q('delete from clubs where id = $1', [id]); tell(acct, { t: 'cl_ev' }); return ['Expulsado. El club se ha quedado vacío y se ha borrado.']; } }
      tell(acct, { t: 'cl_ev' }); await clubTell(id); return ['Expulsado del club.'];
    }
    if (a === 'club_msgdel') { const mid = Number(f.get('msg')) || 0; await q('delete from club_msgs where id = $1 and club = $2', [mid, id]);
      for (const r of await q('select acct from club_members where club = $1', [id])) tell(r.acct, { t: 'cl_msgdel', id: mid }); return ['Mensaje borrado.']; }
  }
  return ['Acción desconocida.', 1];
}

function adminHttp(req, res) {
  const KEY = process.env.ADMIN_KEY || '';
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const html = (code, h, hd) => { res.writeHead(code, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' }, hd || {})); res.end(h); };
  const go = (loc, hd) => { res.writeHead(303, Object.assign({ location: loc, 'cache-control': 'no-store' }, hd || {})); res.end(); };
  const secure = /^https/.test(String(req.headers['x-forwarded-proto'] || '')) ? '; Secure' : '';
  const login = m => html(200, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#120c10"><title>Panel · Marble Fights</title><style>${ADM_CSS}</style></head><body><div class="login"><form method="post" action="/admin"><input type="hidden" name="a" value="login"><span class="logo">M</span><h1>Panel de Marble Fights</h1><p>Solo para el administrador.</p>${m ? `<p class="err">${escH(m)}</p>` : ''}<input type="password" name="key" placeholder="Contraseña (ADMIN_KEY)" autocomplete="current-password" autofocus><button class="btn gold">Entrar</button></form></div></body></html>`);
  if (!KEY) return html(200, '<meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px system-ui;padding:20px">El panel está desactivado: pon la variable <b>ADMIN_KEY</b> en Render → Environment.</p>');
  const sess = admAuthed(req);
  if (req.method === 'POST') {
    let body = ''; req.on('data', c => { if (body.length < 8192) body += c; });
    req.on('end', async () => {
      const f = new URLSearchParams(body), a = f.get('a');
      if (a === 'logout') { if (sess) admSess.delete(sess); return go('/admin', { 'set-cookie': `mfadm=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}` }); }
      if (a === 'login' || !sess) {
        if (hit('admin:' + ip, 30, 60e3)) return login('Demasiados intentos. Espera un minuto.');
        const key = f.get('key') || '';
        if (key.length !== KEY.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(KEY))) { hit('adminbad:' + ip, 5, 15 * 60e3); return login(a === 'login' ? 'Contraseña incorrecta.' : 'La sesión ha caducado. Vuelve a entrar.'); }
        const tok = crypto.randomBytes(24).toString('base64url'); admSess.set(tok, Date.now() + 12 * 3600e3);
        if (admSess.size > 50) { const now = Date.now(); for (const [k, e] of admSess) if (e < now) admSess.delete(k); }
        return go('/admin', { 'set-cookie': `mfadm=${tok}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=43200${secure}` });
      }
      let r; try { r = await admAction(f); } catch (e) { console.error('panel', a, e.message); r = ['Error: ' + e.message, 1]; }
      let back = String(f.get('back') || '/admin'); if (!/^\/admin(\?|$)/.test(back)) back = '/admin';
      go(back + (back.includes('?') ? '&' : '?') + new URLSearchParams(r[1] ? { m: r[0], e: '1' } : { m: r[0] }).toString());
    });
    return;
  }
  if (!sess) return login('');
  (async () => {
    const u = new URL(req.url, 'http://x'), p = u.searchParams, t = p.get('t') || 'home', m = p.get('m') || '', err = p.get('e') === '1';
    const badges = { bans: [...bans.values()].filter(banLive).length || 0, more: maintOn() ? '!' : 0 };
    try { if (dbReady) badges.reports = (await q(`select count(*)::int as n from reports where created > now() - interval '24 hours'`))[0].n || 0; } catch (e) {}
    if (!dbReady && t !== 'bans') return html(200, admShell(t, 'Panel', `<div class="card"><p class="none">La base de datos todavía no está lista. Solo funciona el apartado Baneos.</p></div>`, { badges, m, err }));
    try {
      if (t === 'players') return html(200, admShell(t, 'Jugadores', await admPlayers(String(p.get('q') || '')), { badges, m, err }));
      if (t === 'player') { const P = await playerInfo(p.get('dev'), p.get('usr')); const nm = (P.acc && P.acc.name) || P.names[0] || 'Jugador';
        return html(200, admShell('players', nm, admPlayerPage(P, ['ban', 'name', 'gift', 'trophy', 'info'].includes(p.get('s')) ? p.get('s') : 'ban'), { badges, m, err, back: admUrl('players') })); }
      if (t === 'bans') return html(200, admShell(t, 'Baneos', await admBans(p.get('pre')), { badges, m, err }));
      if (t === 'gifts') return html(200, admShell(t, 'Regalos', await admGifts(), { badges, m, err }));
      if (t === 'reports') return html(200, admShell(t, 'Denuncias', await admReports(), { badges, m, err }));
      if (t === 'more') return html(200, admShell('more', 'Más', admMore(), { badges, m, err }));
      const sub = { badges, m, err, back: admUrl('more') };
      if (t === 'game') return html(200, admShell('more', 'Juego', admGame(), sub));
      if (t === 'promos') return html(200, admShell('more', 'Códigos', await admPromos(), sub));
      if (t === 'clubs') return html(200, admShell('more', 'Clubs', await admClubs(p.get('q')), sub));
      if (t === 'club') return html(200, admShell('more', 'Club', await admClub(Number(p.get('id')) || 0), Object.assign({}, sub, { back: admUrl('clubs') })));
      if (t === 'matches') return html(200, admShell('more', 'Combates', await admMatches(p.get('q')), sub));
      return html(200, admShell('home', 'Panel · Marble Fights', await admHome(), { badges, m, err }));
    } catch (e) { console.error('panel', t, e.message); html(200, admShell(t, 'Error', `<div class="card"><p class="none">Error: ${escH(e.message)}</p></div>`, { badges })); }
  })();
}

const server = http.createServer((req, res) => {
  if (req.url === '/ping' || req.url.startsWith('/ping?')) { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end('ok'); return; }   // para mantenerlo despierto (no toca la base de datos)
  if (req.url && req.url.startsWith('/acct/')) return acctHttp(req, res);
  if (req.url && /^\/admin(\?|$|\/)/.test(req.url)) return adminHttp(req, res);
  if (req.url && req.url.startsWith('/ban')) {   // ¿este ID está baneado? (el juego lo pregunta al abrirse y al darle a jugar)
    let id = '', n = '', v = '', u = ''; try { const q = new URL(req.url, 'http://x').searchParams; id = String(q.get('id') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20); n = String(q.get('n') || '').slice(0, 24); v = String(q.get('v') || '').slice(0, 12); u = String(q.get('u') || '').slice(0, 20); } catch (e) {}
    const B = banInfo(id, n, u), b = !!B;
    if (id) seenNote(id, n, u, v);
    if (id) console.log(`abrir · id=${id} · apodo=${n || '?'}${u ? ' · cuenta=' + u : ''} · versión=${v || '?'} · baneado=${b ? 'SÍ' : 'no'}`);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    const gift = !!id && (giftPend.has('D:' + id) || (devAcct.has(id) && giftPend.has('A:' + devAcct.get(id))) || gAllPending(id, devAcct.get(id) || ''));
    const N = noticeNow();
    res.end(JSON.stringify(Object.assign({ banned: b }, b ? banOut(B) : {}, gift ? { gift: true } : {}, maintOn() ? { maint: SET.maint.msg || '' } : {}, N ? { notice: { id: N.id, title: N.title || '', text: N.text } } : {}))); return;
  }
  if (req.url && req.url.startsWith('/top')) {
    try { const q = new URL(req.url, 'http://x').searchParams; if (q.get('n') && !(dbReady && nameOwner.has(String(q.get('n')).trim().toLowerCase()))) record(cleanLoadout({ name: q.get('n'), trophies: q.get('t'), id: q.get('b') })); } catch (e) {}
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ top: top3(), players: board.size })); return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(`Mis Bolas PVP funcionando · conectados: ${clients.size} · buscando: ${queue.length} · combates: ${matchesPlayed} · baneados: ${[...bans.values()].filter(banLive).length} · versión mínima: ${MIN_VERSION ? 'v' + MIN_VERSION : 'ninguna'} · cuentas y amigos: ${dbReady ? 'sí' : pool ? 'base de datos sin conectar' : 'no (falta DATABASE_URL)'}\n`);
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

function createRoom(a, b, kind) {
  const [host, guest] = Math.random() < .5 ? [a, b] : [b, a];
  const room = { id: nextRoom++, host, guest, kind: kind || 'comp', seed: (Math.random() * 4294967295) >>> 0,
    arena: ARENAS[Math.floor(Math.random() * ARENAS.length)], t0: Date.now(), closed: false };
  host.room = guest.room = room; matchesPlayed++;
  room.cardT = setTimeout(() => roomCards(room), 26000);   // ruleta + 10 s para elegir + margen: si alguien no elige, se empieza igual
  const base = { t: 'match', room: room.id, seed: room.seed, arena: room.arena, A: host.loadout, B: guest.loadout }; if (kind) base.kind = kind;
  send(host, { ...base, role: 'host', you: 'A' });
  send(guest, { ...base, role: 'guest', you: 'B' });
}

function roomCards(room) {
  if (!room || room.closed || room.cardsSent) return; room.cardsSent = true; clearTimeout(room.cardT);
  const c = room.cards || {}, msg = { t: 'cards', A: c.A || null, B: c.B || null };
  send(room.host, msg); send(room.guest, msg);
}
function roomLog(room, winner, reason) {   // v298 · cada combate en línea queda apuntado para el panel
  if (!dbReady || !room || room.logged) return; room.logged = true;
  const P = w => { const l = w.loadout || {}; return [String(l.name || '').slice(0, 20), w.dev || '', w.u || '', Number(l.trophies) || 0]; };
  const c = room.cards || {}, cd = x => x && x.id ? x.id + ' ' + x.lv : '';
  q(`insert into matches (kind, winner, reason, dur, a_name, a_dev, a_user, a_tr, a_card, b_name, b_dev, b_user, b_tr, b_card) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [room.kind, winner, reason || '', Math.round((Date.now() - room.t0) / 1000), ...P(room.host), cd(c.A), ...P(room.guest), cd(c.B)]).catch(e => console.error('combates', e.message));
  q(`delete from matches where created < now() - interval '30 days'`).catch(() => {});
}
function closeRoom(room, msgHost, msgGuest) {
  if (room) clearTimeout(room.cardT);
  if (!room || room.closed) return;
  room.closed = true;
  { const m = msgGuest || msgHost; if (m) roomLog(room, m.winner || null, m.reason || 'fin'); }
  if (room.host.room === room) room.host.room = null;
  if (room.guest.room === room) room.guest.room = null;
  if (msgHost) send(room.host, msgHost);
  if (msgGuest) send(room.guest, msgGuest);
}

/* ================= Amigos (con la cuenta de la nube) =================
   Cada cuenta tiene un jugador con código de amigo MF-XXXXXX. La conexión se identifica con el token de sesión. */
const MAX_FRIENDS = 100;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => 'MF-' + Array.from(crypto.randomBytes(6), b => CODE_ABC[b % 32]).join('');
const normCode = v => { v = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (v.startsWith('MF')) v = v.slice(2); return v.length === 6 ? 'MF-' + v : null; };
const online = new Map();                 // id de cuenta → conexiones abiertas
const isOnline = id => { const s = online.get(id); return !!(s && s.size); };
const tell = (id, o) => { const s = online.get(id); if (s) for (const w of s) send(w, o); };
async function socAuth(ws, m) {
  if (!dbReady) return send(ws, { t: 'auth', err: 'nodb' });
  const prof = cleanLoadout(m.loadout);
  if (!ws.pid) {
    const A = await bySession(str(m.token, 80)); if (!A) return send(ws, { t: 'auth', err: 'auth' });
    if (banInfo(ws.dev, '', A.username)) return send(ws, { t: 'auth', err: 'banned' });
    let r = await q('select code from players where id = $1', [A.id]);
    if (!r.length) { for (let i = 0; i < 6 && !r.length; i++) r = await q('insert into players (id, code) values ($1, $2) on conflict do nothing returning code', [A.id, newCode()]); }
    if (!r.length) return send(ws, { t: 'auth', err: 'db' });
    ws.pid = A.id; ws.code = r[0].code; ws.user = A.username;
    if (!online.has(A.id)) online.set(A.id, new Set());
    const first = !online.get(A.id).size; online.get(A.id).add(ws);
    if (first) friendsTell(A.id);   // tus amigos te ven conectado
  }
  await saveProfile(ws, prof);
  send(ws, { t: 'auth', code: ws.code });
  await sendFriends(ws);
}
async function saveProfile(ws, l) {
  if (!dbReady || !ws.pid || !l) return;
  const name = l.name !== 'Jugador' && !mfBadName(l.name) ? l.name : 'Jugador';
  await q('update players set name = $2, trophies = $3, ball = $4, seen = now() where id = $1', [ws.pid, name, l.trophies, l.id]);
}
async function friendsTell(id) { try { const rows = await q('select case when a = $1 then b else a end as o from friends where (a = $1 or b = $1) and ok', [id]); for (const r of rows) tell(r.o, { t: 'fr_ev' }); } catch (e) {} }
async function sendFriends(ws, extra) {
  const rows = await q(`select p.id, p.code, p.name, p.trophies, p.ball, f.ok, (f.a = $1) as mine
    from friends f join players p on p.id = case when f.a = $1 then f.b else f.a end
    where f.a = $1 or f.b = $1 order by f.ok desc, p.trophies desc, p.name limit 250`, [ws.pid]);
  send(ws, { t: 'fr', ...(extra || {}), list: rows.map(r => ({ code: r.code, name: r.name, trophies: r.trophies, ball: r.ball,
    st: r.ok ? 'ok' : r.mine ? 'out' : 'in', on: r.ok ? isOnline(r.id) : false })) });
}
async function target(ws, m) {
  const code = normCode(m.code); if (!code) return null;
  const r = await q('select id, name from players where code = $1', [code]);
  return r.length && r[0].id !== ws.pid ? r[0] : (r.length ? { self: true } : null);
}
async function social(ws, m) {
  if (m.t === 'auth') return socAuth(ws, m);
  if (!dbReady) return send(ws, { t: 'fr', err: 'nodb', list: [] });
  if (!ws.pid) return send(ws, { t: 'fr', err: 'noauth', list: [] });
  const me = ws.pid;
  if (m.t === 'fr_list') return sendFriends(ws);
  if (m.t.startsWith('ch_')) return challenge(ws, m);
  if (m.t.startsWith('cl_')) return club(ws, m);
  const tg = await target(ws, m);
  if (!tg) return sendFriends(ws, { op: m.t, err: 'nf' });
  if (tg.self) return sendFriends(ws, { op: m.t, err: 'self' });
  if (m.t === 'fr_add') {
    const blk = await q('select 1 from blocks where (a = $1 and b = $2) or (a = $2 and b = $1)', [me, tg.id]);
    if (blk.length) return sendFriends(ws, { op: m.t, err: 'nf' });
    const ex = await q('select a, ok from friends where (a = $1 and b = $2) or (a = $2 and b = $1)', [me, tg.id]);
    if (ex.length && (ex[0].ok || ex[0].a === me)) return sendFriends(ws, { op: m.t, err: 'dup' });
    const n = await q('select (select count(*) from friends where a = $1 or b = $1)::int as mine, (select count(*) from friends where a = $2 or b = $2)::int as theirs', [me, tg.id]);
    if (n[0].mine >= MAX_FRIENDS) return sendFriends(ws, { op: m.t, err: 'full' });
    if (n[0].theirs >= MAX_FRIENDS) return sendFriends(ws, { op: m.t, err: 'full2' });
    if (ex.length) await q('update friends set ok = true where a = $2 and b = $1', [me, tg.id]);
    else await q('insert into friends (a, b) values ($1, $2) on conflict do nothing', [me, tg.id]);
    tell(tg.id, { t: 'fr_ev' });
    return sendFriends(ws, { op: m.t, ok: ex.length ? 'friends' : 'sent', name: tg.name });
  }
  if (m.t === 'fr_ok') {
    const r = await q('update friends set ok = true where a = $2 and b = $1 and not ok returning a', [me, tg.id]);
    if (r.length) tell(tg.id, { t: 'fr_ev' });
    return sendFriends(ws, { op: m.t, ok: r.length ? 'friends' : undefined, name: tg.name });
  }
  if (m.t === 'fr_del' || m.t === 'fr_rep') {
    if (m.t === 'fr_rep') {
      await q('insert into reports (by_who, target, target_name, why) values ($1, $2, $3, $4)', [me, tg.id, tg.name, str(m.why, 200)]);
      await q('insert into blocks (a, b) values ($1, $2) on conflict do nothing', [me, tg.id]);
      console.log(`DENUNCIA · ${ws.user} denuncia a «${tg.name}» · motivo: ${str(m.why, 60)}`);
    }
    await q('delete from friends where (a = $1 and b = $2) or (a = $2 and b = $1)', [me, tg.id]);
    tell(tg.id, { t: 'fr_ev' });
    return sendFriends(ws, { op: m.t, ok: m.t === 'fr_rep' ? 'reported' : 'removed', name: tg.name });
  }
}
/* ---------- Retar a un amigo: combate amistoso (sin trofeos) ---------- */
const chals = new Map();      // id → { from, to, fromName, exp }
const privKeys = new Map();   // clave → caducidad (la usan los dos al buscar partida)
let chalN = 1;
async function areFriends(a, b) { const r = await q('select 1 from friends where ((a = $1 and b = $2) or (a = $2 and b = $1)) and ok', [a, b]); return r.length > 0; }
async function challenge(ws, m) {
  const me = ws.pid, myName = ws.user;
  if (m.t === 'ch_send') {
    const tg = await target(ws, m); if (!tg || tg.self) return send(ws, { t: 'ch', st: 'nf' });
    if (!(await areFriends(me, tg.id))) return send(ws, { t: 'ch', st: 'nf' });
    if (!isOnline(tg.id)) return send(ws, { t: 'ch', st: 'off', name: tg.name });
    for (const [k, c] of chals) if (c.from === me) chals.delete(k);      // solo un reto a la vez
    const id = String(chalN++); const nm = (await q('select name, ball from players where id = $1', [me]))[0] || {};
    chals.set(id, { from: me, to: tg.id, toName: tg.name, toCode: normCode(m.code), fromCode: ws.code, fromName: nm.name || myName, exp: Date.now() + 30000 });
    tell(tg.id, { t: 'ch_in', id, name: nm.name || myName, ball: nm.ball || 'filo', code: ws.code });
    return send(ws, { t: 'ch', st: 'sent', id, name: tg.name });
  }
  const c = chals.get(str(m.id, 12));
  if (m.t === 'ch_cancel') { if (c && c.from === me) { chals.delete(str(m.id, 12)); tell(c.to, { t: 'ch_off', id: m.id }); } return; }
  if (m.t === 'ch_ans') {
    if (!c || c.to !== me || Date.now() > c.exp) return send(ws, { t: 'ch', st: 'gone' });
    chals.delete(str(m.id, 12));
    if (!m.ok) { tell(c.from, { t: 'ch', st: m.busy ? 'busy' : 'no', name: c.toName }); return; }
    const key = crypto.randomBytes(9).toString('base64url'); privKeys.set(key, Date.now() + 90000);
    tell(c.from, { t: 'ch_go', key, name: c.toName, code: c.toCode }); tell(me, { t: 'ch_go', key, name: c.fromName, code: c.fromCode });
  }
}
setInterval(() => { const now = Date.now(); for (const [k, c] of chals) if (now > c.exp) { chals.delete(k); tell(c.from, { t: 'ch', st: 'timeout', name: c.toName }); tell(c.to, { t: 'ch_off', id: k }); }
  for (const [k, e] of privKeys) if (now > e) privKeys.delete(k); }, 3000);

/* ---------- Clubs: abiertos, hasta 30 miembros, uno por jugador ---------- */
const CLUB_MAX = 30, BADGES = ['oro', 'rojo', 'azul', 'verde', 'morado', 'negro'];
const cleanTxt = (v, n) => String(v || '').replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
async function clubOf(id) { const r = await q('select club, role from club_members where acct = $1', [id]); return r[0] || null; }
async function clubSend(ws, extra) {
  const mine = await clubOf(ws.pid);
  if (!mine) return send(ws, { t: 'cl', ...(extra || {}), club: null });
  const c = (await q('select id, name, descr, badge, owner from clubs where id = $1', [mine.club]))[0];
  if (!c) return send(ws, { t: 'cl', ...(extra || {}), club: null });
  const mem = await q(`select p.id, p.code, p.name, p.trophies, p.ball, m.role from club_members m join players p on p.id = m.acct where m.club = $1 order by p.trophies desc, p.name`, [c.id]);
  send(ws, { t: 'cl', ...(extra || {}), club: { id: Number(c.id), name: c.name, descr: c.descr, badge: c.badge, mine: c.owner === ws.pid,
    trophies: mem.reduce((s, x) => s + (Number(x.trophies) || 0), 0),
    members: mem.map(x => ({ code: x.code, name: x.name, trophies: Number(x.trophies) || 0, ball: x.ball, lead: x.role === 'owner', on: isOnline(x.id), me: x.id === ws.pid })) } });
}
const clubTell = async (clubId, except) => { try { for (const r of await q('select acct from club_members where club = $1', [clubId])) if (r.acct !== except) tell(r.acct, { t: 'cl_ev' }); } catch (e) {} };
/* ---------- v297 · chat del club: últimos 50 mensajes; las palabras feas salen con asteriscos; se pueden denunciar ---------- */
const chatClean = t => String(t || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140)
  .split(' ').map(w => (w.replace(/[^\p{L}\p{N}]/gu, '').length >= 2 && mfBadName(w)) ? '*'.repeat(Math.min(8, w.length)) : w).join(' ');
const chatOut = r => ({ id: Number(r.id), code: r.code || '', name: r.name, text: r.text, ts: Number(r.ts) });
async function clubChat(ws, m) {
  const me = ws.pid, mine = await clubOf(me); if (!mine) return send(ws, { t: 'cl_chat', list: [], none: true });
  if (m.t === 'cl_chat_get') {
    const rows = await q(`select c.id, c.name, c.text, p.code, (extract(epoch from c.created) * 1000)::bigint as ts from club_msgs c left join players p on p.id = c.acct where c.club = $1 order by c.id desc limit 50`, [mine.club]);
    return send(ws, { t: 'cl_chat', list: rows.reverse().map(chatOut) });
  }
  if (m.t === 'cl_chat_send') {
    if (isBanned(ws.dev, '', ws.user)) return send(ws, { t: 'cl_chat_err', err: 'banned' });
    const now = Date.now(); ws.chatT = (ws.chatT || []).filter(t => now - t < 60000); if (ws.chatT.length >= 15 || (ws.chatT.length && now - ws.chatT[ws.chatT.length - 1] < 1200)) return send(ws, { t: 'cl_chat_err', err: 'slow' });
    const text = chatClean(m.text); if (!text) return; ws.chatT.push(now);
    const pl = (await q('select name, code from players where id = $1', [me]))[0] || {};
    const row = (await q(`insert into club_msgs (club, acct, name, text) values ($1, $2, $3, $4) returning id, (extract(epoch from created) * 1000)::bigint as ts`, [mine.club, me, pl.name || ws.user, text]))[0];
    q(`delete from club_msgs where club = $1 and id < (select coalesce(min(id), 0) from (select id from club_msgs where club = $1 order by id desc limit 200) k)`, [mine.club]).catch(() => {});
    const out = { t: 'cl_msg', m: chatOut({ id: row.id, name: pl.name || ws.user, text, code: pl.code, ts: row.ts }) };
    for (const r of await q('select acct from club_members where club = $1', [mine.club])) tell(r.acct, out);
    return;
  }
  const id = Number(m.id) || 0, msg = (await q('select id, acct, name, text from club_msgs where id = $1 and club = $2', [id, mine.club]))[0];
  if (!msg) return;
  if (m.t === 'cl_chat_del') {
    if (msg.acct !== me && mine.role !== 'owner') return;
    await q('delete from club_msgs where id = $1', [id]);
    for (const r of await q('select acct from club_members where club = $1', [mine.club])) tell(r.acct, { t: 'cl_msgdel', id });
    return;
  }
  if (m.t === 'cl_chat_rep') {
    if (msg.acct === me) return;
    await q('insert into reports (by_who, target, target_name, why) values ($1, $2, $3, $4)', [me, msg.acct, msg.name, ('Chat del club: «' + msg.text + '»').slice(0, 120)]);
    console.log(`DENUNCIA chat · ${ws.user} → ${msg.name}: ${msg.text}`);
    return send(ws, { t: 'cl_chat_err', err: 'reported', name: msg.name });
  }
}
async function club(ws, m) {
  const me = ws.pid;
  if (m.t === 'cl_mine') return clubSend(ws);
  if (m.t.startsWith('cl_chat')) return clubChat(ws, m);
  if (m.t === 'cl_search') {
    const qs = cleanTxt(m.q, 20).toLowerCase();
    const rows = await q(`select c.id, c.name, c.descr, c.badge, count(m.acct)::int as n, coalesce(sum(p.trophies), 0)::int as tr
      from clubs c left join club_members m on m.club = c.id left join players p on p.id = m.acct
      where ($1 = '' or c.name_lc like '%' || $1 || '%') group by c.id order by tr desc, c.id limit 30`, [qs.replace(/[%_]/g, '')]);
    return send(ws, { t: 'cl_list', list: rows.map(r => ({ id: Number(r.id), name: r.name, descr: r.descr, badge: r.badge, n: r.n, trophies: r.tr })) });
  }
  if (m.t === 'cl_create') {
    if (await clubOf(me)) return clubSend(ws, { err: 'inclub' });
    const name = cleanTxt(m.name, 20), descr = cleanTxt(m.descr, 80), badge = BADGES.includes(m.badge) ? m.badge : 'oro';
    if (name.length < 3) return clubSend(ws, { err: 'name' });
    if (mfBadName(name) || (descr && mfBadName(descr.replace(/\s+/g, '')))) return clubSend(ws, { err: 'bad' });
    let c;
    try { c = (await q('insert into clubs (name, name_lc, descr, badge, owner) values ($1, $2, $3, $4, $5) returning id', [name, name.toLowerCase(), descr, badge, me]))[0]; }
    catch (e) { if (/unique|duplicate/i.test(e.message)) return clubSend(ws, { err: 'taken' }); throw e; }
    await q(`insert into club_members (acct, club, role) values ($1, $2, 'owner')`, [me, c.id]);
    console.log(`CLUB nuevo · «${name}» · por ${ws.user}`);
    return clubSend(ws, { ok: 'created' });
  }
  if (m.t === 'cl_join') {
    if (await clubOf(me)) return clubSend(ws, { err: 'inclub' });
    const id = Number(m.id) || 0, c = (await q('select id, name from clubs where id = $1', [id]))[0]; if (!c) return clubSend(ws, { err: 'nf' });
    const n = (await q('select count(*)::int as n from club_members where club = $1', [id]))[0].n; if (n >= CLUB_MAX) return clubSend(ws, { err: 'full' });
    await q(`insert into club_members (acct, club) values ($1, $2) on conflict do nothing`, [me, id]);
    clubTell(id, me); return clubSend(ws, { ok: 'joined', name: c.name });
  }
  if (m.t === 'cl_leave') {
    const mine = await clubOf(me); if (!mine) return clubSend(ws);
    await q('delete from club_members where acct = $1', [me]);
    if (mine.role === 'owner') {   // el líder se va: pasa al miembro más antiguo; si no queda nadie, se borra el club
      const next = (await q('select acct from club_members where club = $1 order by joined limit 1', [mine.club]))[0];
      if (next) { await q(`update club_members set role = 'owner' where acct = $1`, [next.acct]); await q('update clubs set owner = $2 where id = $1', [mine.club, next.acct]); }
      else await q('delete from clubs where id = $1', [mine.club]);
    }
    clubTell(mine.club, me); return clubSend(ws, { ok: 'left' });
  }
  if (m.t === 'cl_kick') {
    const mine = await clubOf(me); if (!mine || mine.role !== 'owner') return clubSend(ws);
    const tg = await target(ws, m); if (!tg || tg.self) return clubSend(ws);
    const r = await q('delete from club_members where acct = $1 and club = $2 returning acct', [tg.id, mine.club]);
    if (r.length) { tell(tg.id, { t: 'cl_ev', kicked: true }); clubTell(mine.club, me); }
    return clubSend(ws, { ok: r.length ? 'kicked' : undefined, name: tg.name });
  }
}

function socialMsg(ws, m) {               // en fila y con freno
  const now = Date.now(); ws.socT = (ws.socT || []).filter(t => now - t < 20000);
  if (ws.socT.length >= 30) return send(ws, { t: 'fr', err: 'slow', list: null });
  ws.socT.push(now);
  ws.chain = (ws.chain || Promise.resolve()).then(() => social(ws, m)).catch(e => { console.error('amigos', e.message); send(ws, { t: m.t === 'auth' ? 'auth' : 'fr', err: 'db', list: null }); });
}

function handle(ws, m) {
  if (m && (['auth', 'fr_list', 'fr_add', 'fr_ok', 'fr_del', 'fr_rep'].includes(m.t) || /^(ch|cl)_[a-z_]+$/.test(m.t || ''))) { if (!ws.dev && m.dev) ws.dev = str(m.dev, 20).toUpperCase().replace(/[^A-Z0-9-]/g, ''); return socialMsg(ws, m); }
  if (!m || typeof m.t !== 'string') return;
  const room = ws.room;
  switch (m.t) {
    case 'find': {
      if (room) return;
      const dev = str(m.dev, 16).toUpperCase().replace(/[^A-Z0-9-]/g, ''), ver = str(m.v, 12);
      ws.dev = dev; ws.u = str(m.u, 20); ws.loadout = cleanLoadout(m.loadout);
      if (maintOn()) { send(ws, { t: 'maint', msg: SET.maint.msg || '' }); return; }
      if (dbReady && !nameMine(ws.loadout.name.toLowerCase(), dev)) ws.loadout.name = 'Jugador';   // apodo de otro jugador: no se puede usar
      console.log(`buscar · id=${dev || '?'} · apodo=${ws.loadout.name} · trofeos=${ws.loadout.trophies} · versión=${ver || '?'}`);
      if (MIN_VERSION && verNum(ver) < MIN_VERSION) { send(ws, { t: 'old' }); return; }
      if (ws.loadout.name !== 'Jugador' && mfBadName(ws.loadout.name)) { banBadName(dev, ws.loadout.name).then(bb => send(ws, Object.assign({ t: 'banned' }, banOut(bb) || { until: 0, reason: 'Nombre inapropiado' }))).catch(() => send(ws, { t: 'banned', until: 0, reason: 'Nombre inapropiado' })); return; }
      { const B = banInfo(dev, ws.loadout.name, str(m.u, 20)); if (B) { bannedNames.add(ws.loadout.name.toLowerCase()); board.delete(ws.loadout.name.toLowerCase()); send(ws, Object.assign({ t: 'banned' }, banOut(B))); return; } }
      if (m.priv) {   // combate amistoso con un amigo: se empareja solo con quien traiga la misma clave
        const key = str(m.priv, 20); if (!privKeys.has(key)) { send(ws, { t: 'privbad' }); return; }
        const other = [...clients].find(o => o !== ws && o.priv === key && !o.room && o.readyState === 1);
        ws.priv = key; leaveQueue(ws);
        if (other) { privKeys.delete(key); other.priv = ws.priv = null; createRoom(other, ws, 'normal'); }
        else send(ws, { t: 'wait', online: clients.size, queue: 0 });
        return;
      }
      ws.qT = Date.now(); record(ws.loadout);
      leaveQueue(ws); queue.push(ws);
      send(ws, { t: 'wait', online: clients.size, queue: queue.length });
      tryMatch();
      break; }
    case 'cancel':
      leaveQueue(ws); ws.priv = null;
      break;
    case 'card': {        // v296 · carta del mazo elegida antes del combate; cuando están las dos (o se acaba el tiempo) se mandan a los dos a la vez
      if (!room || room.closed || room.cardsSent) return;
      const id = str(m.id, 16).replace(/[^a-z]/g, ''), lv = int(m.lv, 1, 5, 1);
      room.cards = room.cards || {}; room.cards[ws === room.host ? 'A' : 'B'] = id ? { id, lv } : null;
      if ('A' in room.cards && 'B' in room.cards) roomCards(room);
      break; }
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
      { const l = cleanLoadout(m.loadout); record(l); saveProfile(ws, l).catch(() => {}); }
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
    if (ws.pid) { const s = online.get(ws.pid); if (s) { s.delete(ws); if (!s.size) { online.delete(ws.pid); friendsTell(ws.pid); } } }
    const room = ws.room;
    if (room && !room.closed) { const other = ws === room.host ? room.guest : room.host; roomLog(room, ws === room.host ? 'B' : 'A', 'desconexión'); closeRoom(room, null, null); send(other, { t: 'left' }); }
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
