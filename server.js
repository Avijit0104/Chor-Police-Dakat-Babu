'use strict';

// Serves the game page and runs the rooms over WebSockets on the same port.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room, GameError } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: they look like 1 and 0
const MAX_ROOMS = 2000;
// How long a bot "thinks" before moving, in ms: [shortest, longest]. A Babu bot's
// pause starts with the round, so it includes the phones' 0.8 s shuffle screen;
// a Police bot gets longer so everyone can watch the investigation.
// Tests set BOT_DELAY_MS to keep it quick.
const BOT_PAUSE = { babu: [3000, 4500], police: [3500, 5500] };
function botDelay(role) {
  if (process.env.BOT_DELAY_MS) return Number(process.env.BOT_DELAY_MS);
  const [min, max] = BOT_PAUSE[role];
  return min + crypto.randomInt(max - min + 1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// code -> { room, sockets: Map<playerId, ws>, idleSince }
const rooms = new Map();

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

function findRoom(code) {
  const entry = rooms.get(String(code ?? '').trim().toUpperCase());
  if (!entry) throw new GameError('No room with that code. Check it and try again.');
  return entry;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(entry) {
  for (const [id, ws] of entry.sockets) send(ws, { type: 'state', state: entry.room.viewFor(id) });
  runBots(entry);
}

// If it is a bot's turn, make its move after a pause, then tell everyone.
function runBots(entry) {
  const move = entry.room.botMove();
  if (entry.botTimer || !move) return;
  entry.botTimer = setTimeout(() => {
    entry.botTimer = null;
    try {
      entry.room.botMove()?.run();
    } catch (err) {
      console.error(err);
    }
    broadcast(entry);
  }, botDelay(move.role));
}

function attach(ws, entry, player) {
  detach(ws);
  const old = entry.sockets.get(player.id);
  if (old && old !== ws) {
    // The same player opened the game somewhere else; the newest connection wins.
    old.entry = null;
    send(old, { type: 'replaced' });
    old.close();
  }
  entry.sockets.set(player.id, ws);
  ws.entry = entry;
  ws.playerId = player.id;
  player.connected = true;
  send(ws, { type: 'joined', code: entry.room.code, token: player.token });
  broadcast(entry);
}

function detach(ws) {
  const entry = ws.entry;
  if (!entry) return;
  ws.entry = null;
  if (entry.sockets.get(ws.playerId) !== ws) return;
  entry.sockets.delete(ws.playerId);
  const player = entry.room.player(ws.playerId);
  if (player) player.connected = false;
  if (entry.sockets.size === 0) entry.idleSince = Date.now();
  broadcast(entry);
}

function handle(ws, msg) {
  switch (msg.type) {
    case 'create': {
      if (rooms.size >= MAX_ROOMS) throw new GameError('The server is busy. Try again in a bit.');
      const room = new Room(newCode());
      const player = room.join(msg.name);
      const entry = { room, sockets: new Map(), idleSince: Date.now() };
      rooms.set(room.code, entry);
      return attach(ws, entry, player);
    }
    case 'join': {
      const entry = findRoom(msg.code);
      return attach(ws, entry, entry.room.join(msg.name));
    }
    case 'resume': {
      const entry = rooms.get(String(msg.code ?? '').toUpperCase());
      const player = entry?.room.players.find((p) => p.token === msg.token);
      if (!player) return send(ws, { type: 'expired' });
      return attach(ws, entry, player);
    }
  }

  const entry = ws.entry;
  if (!entry) throw new GameError('You are not in a room.');
  const { room } = entry;
  const me = ws.playerId;
  switch (msg.type) {
    case 'start': room.start(me); break;
    case 'choose': room.choose(me, msg.target); break;
    case 'guess': room.guess(me, msg.playerId); break;
    case 'ready': room.setReady(me, msg.value); break;
    case 'stop': room.voteStop(me, msg.value); break;
    case 'restart': room.restart(me); break;
    case 'kick': room.kick(me, msg.playerId); break;
    case 'leave':
      room.leave(me);
      detach(ws);
      if (room.humans().length === 0) rooms.delete(room.code);
      return send(ws, { type: 'left' });
    default:
      return;
  }
  broadcast(entry);
}

const server = http.createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  };
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') return reply(200, 'ok');
  let file;
  try {
    file = path.join(PUBLIC_DIR, decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  } catch {
    return reply(400, 'Bad request');
  }
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return reply(404, 'Not found');
  fs.readFile(file, (err, body) => {
    if (err) return reply(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    try {
      handle(ws, msg ?? {});
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      send(ws, { type: 'error', message: err instanceof GameError ? err.message : 'Something went wrong.' });
    }
  });
  ws.on('close', () => detach(ws));
});

// Drop connections from phones that went away without saying goodbye.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

// Forget rooms nobody has been connected to for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of rooms) {
    const limit = entry.room.phase === 'lobby' ? 30 * 60_000 : 6 * 60 * 60_000;
    if (entry.sockets.size === 0 && now - entry.idleSince > limit) rooms.delete(code);
  }
}, 5 * 60_000);

server.listen(PORT, () => {
  console.log(`CPDB is running on http://localhost:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`Phones on the same Wi-Fi can open http://${a.address}:${PORT}`);
    }
  }
});
