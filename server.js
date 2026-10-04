// Mis Bolas · servidor PVP en línea
// Empareja jugadores, crea salas y reenvía la sincronización del combate.
// El "anfitrión" (host) de cada sala calcula el combate y manda instantáneas al "invitado" (guest).
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ARENAS = ['clasica', 'pilares', 'electrica', 'hielo', 'portales', 'pinball'];
const MAX_MATCH_MS = 4 * 60 * 1000;      // una sala no dura más de 4 minutos
const clients = new Set();
let queue = [];                            // jugadores buscando rival
let nextId = 1, nextRoom = 1, matchesPlayed = 0;
// Clasificación: última puntuación conocida de cada apodo (en memoria: se borra si el servidor se reinicia)
const board = new Map();
function record(l) {
  if (!l || !l.name || l.name === 'Jugador') return;
  const key = l.name.toLowerCase(), old = board.get(key);  // se guarda la puntuación más reciente de cada apodo
  board.set(key, { name: l.name, trophies: l.trophies, ball: l.id, at: old && old.trophies === l.trophies ? old.at : Date.now() });
  if (board.size > 5000) { const worst = [...board.entries()].sort((a, b) => a[1].trophies - b[1].trophies)[0]; board.delete(worst[0]); }
}
const top3 = () => [...board.values()].sort((a, b) => b.trophies - a.trophies || a.at - b.at).slice(0, 3).map(({ name, trophies, ball }) => ({ name, trophies, ball }));

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/top')) {
    try { const q = new URL(req.url, 'http://x').searchParams; if (q.get('n')) record(cleanLoadout({ name: q.get('n'), trophies: q.get('t'), id: q.get('b') })); } catch (e) {}
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ top: top3(), players: board.size })); return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(`Mis Bolas PVP funcionando · conectados: ${clients.size} · buscando: ${queue.length} · combates: ${matchesPlayed}\n`);
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
    case 'find':
      if (room) return;
      ws.loadout = cleanLoadout(m.loadout); ws.qT = Date.now(); record(ws.loadout);
      leaveQueue(ws); queue.push(ws);
      send(ws, { t: 'wait', online: clients.size, queue: queue.length });
      tryMatch();
      break;
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
