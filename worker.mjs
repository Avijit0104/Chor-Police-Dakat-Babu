// CPDB on Cloudflare (free plan): a Worker serves public/ and sends /ws to one Durable Object that runs
// every room, like server.js does on Node. The rules come unchanged from game.js.
//
// Differences from server.js, because a Durable Object can be put to sleep ("hibernate") whenever nobody
// is sending anything:
// - Rooms are saved to the object's storage after every change and loaded again after a sleep, a restart
//   or a new deploy. So, unlike on Render, a deploy doesn't end the games in progress.
// - Open connections don't keep the object awake: phones send "ping" every 20 s and Cloudflare answers
//   "pong" without waking it. A connection whose last ping is older than STALE_MS counts as gone.
// - Old rooms are cleaned up by an alarm instead of setInterval.
import { DurableObject } from 'cloudflare:workers';
import game from './game.js';

const { Room, GameError } = game;

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: they look like 1 and 0
const MAX_ROOMS = 2000;
const MAX_MESSAGE = 4096;
// No ping for this long = the phone went away without saying goodbye. Generous, because browsers slow
// background tabs' timers down to about once a minute.
const STALE_MS = 150_000;
const CLEANUP_EVERY_MS = 30 * 60_000;
// Same bot pauses as server.js: [shortest, longest] in ms.
const BOT_PAUSE = { babu: [3000, 4500], police: [3500, 5500] };

const randomInt = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
const botDelay = (role, env) => {
  if (env.BOT_DELAY_MS) return Number(env.BOT_DELAY_MS);
  const [min, max] = BOT_PAUSE[role];
  return min + randomInt(max - min + 1);
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/healthz') return new Response('ok', { headers: { 'Cache-Control': 'no-store' } });
    if (pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      // One object runs every room. It is created near the first player (asia-pacific hint) and stays there.
      const stub = env.GAME.get(env.GAME.idFromName('cpdb'), { locationHint: 'apac' });
      return stub.fetch(request);
    }
    // Everything else that isn't a file in public/ (files are served before this code runs).
    return new Response('Not found', { status: 404 });
  },
};

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.rooms = new Map(); // code -> { room, idleSince, botTimer } (a cache of what's in storage)
    // Answer the phones' keep-alive pings without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch() {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ code: null, playerId: null, since: Date.now() });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---------- storage ----------

  async load(code) {
    code = String(code ?? '').trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return null;
    if (this.rooms.has(code)) return this.rooms.get(code);
    const saved = await this.ctx.storage.get(`room:${code}`);
    if (!saved) return null;
    if (this.rooms.has(code)) return this.rooms.get(code); // loaded by another message meanwhile
    const entry = { room: Object.assign(Object.create(Room.prototype), saved.room), idleSince: saved.idleSince, botTimer: null };
    this.rooms.set(code, entry);
    return entry;
  }

  save(entry) {
    // Writes are queued in order and confirmed before the next reply leaves (output gates), so no await needed.
    this.ctx.storage.put(`room:${entry.room.code}`, { room: { ...entry.room }, idleSince: entry.idleSince });
  }

  drop(code) {
    const entry = this.rooms.get(code);
    if (entry?.botTimer) clearTimeout(entry.botTimer);
    this.rooms.delete(code);
    this.ctx.storage.delete(`room:${code}`);
  }

  async newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
      if (!(await this.load(code))) return code;
    }
  }

  // ---------- connections ----------

  info(ws) {
    return ws.deserializeAttachment() ?? {};
  }

  setInfo(ws, info) {
    ws.serializeAttachment(info);
  }

  // A connection counts as live if it pinged (or connected) recently.
  alive(ws) {
    const last = Math.max(this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0, this.info(ws).since ?? 0);
    return ws.readyState === WebSocket.OPEN && Date.now() - last < STALE_MS;
  }

  socketsIn(code) {
    const map = new Map(); // playerId -> ws
    for (const ws of this.ctx.getWebSockets()) {
      const { code: c, playerId } = this.info(ws);
      if (c === code && playerId != null) map.set(playerId, ws);
    }
    return map;
  }

  // Players whose phones vanished without closing the connection become "offline", like server.js's 25 s pings.
  reap(entry) {
    let changed = false;
    for (const [id, ws] of this.socketsIn(entry.room.code)) {
      if (this.alive(ws)) continue;
      this.setInfo(ws, { ...this.info(ws), code: null, playerId: null });
      try { ws.close(1001, 'Gone quiet'); } catch {}
      const player = entry.room.player(id);
      if (player && !player.bot && player.connected) { player.connected = false; changed = true; }
    }
    return changed;
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* closing */ }
  }

  broadcast(entry) {
    const sockets = this.socketsIn(entry.room.code);
    if (sockets.size === 0) entry.idleSince ??= Date.now();
    else entry.idleSince = null;
    this.save(entry);
    for (const [id, ws] of sockets) this.send(ws, { type: 'state', state: entry.room.viewFor(id) });
    this.runBots(entry);
  }

  // If it is a bot's turn, make its move after a pause, then tell everyone.
  // (Also restarts a bot's move that was waiting when the object went to sleep or restarted.)
  runBots(entry) {
    const move = entry.room.botMove();
    if (entry.botTimer || !move) return;
    entry.botTimer = setTimeout(() => {
      entry.botTimer = null;
      try { entry.room.botMove()?.run(); } catch (err) { console.error(err); }
      this.broadcast(entry);
    }, botDelay(move.role, this.env));
  }

  attach(ws, entry, player) {
    this.detach(ws);
    const old = this.socketsIn(entry.room.code).get(player.id);
    if (old && old !== ws) {
      // The same player opened the game somewhere else; the newest connection wins.
      this.setInfo(old, { ...this.info(old), code: null, playerId: null });
      this.send(old, { type: 'replaced' });
      try { old.close(1000, 'Replaced'); } catch {}
    }
    this.setInfo(ws, { ...this.info(ws), code: entry.room.code, playerId: player.id });
    player.connected = true;
    this.send(ws, { type: 'joined', code: entry.room.code, token: player.token });
    this.broadcast(entry);
  }

  detach(ws) {
    const { code, playerId } = this.info(ws);
    if (!code) return;
    this.setInfo(ws, { ...this.info(ws), code: null, playerId: null });
    const entry = this.rooms.get(code);
    if (!entry) return;
    const player = entry.room.player(playerId);
    if (player) player.connected = false;
    this.broadcast(entry);
  }

  async handle(ws, msg) {
    switch (msg.type) {
      case 'create': {
        const count = (await this.ctx.storage.list({ prefix: 'room:', limit: MAX_ROOMS })).size;
        if (count >= MAX_ROOMS) throw new GameError('The server is busy. Try again in a bit.');
        const room = new Room(await this.newCode());
        const player = room.join(msg.name);
        const entry = { room, idleSince: null, botTimer: null };
        this.rooms.set(room.code, entry);
        this.scheduleCleanup();
        return this.attach(ws, entry, player);
      }
      case 'join': {
        const entry = await this.load(msg.code);
        if (!entry) throw new GameError('No room with that code. Check it and try again.');
        this.reap(entry); // a seat whose phone vanished can be taken back by name
        return this.attach(ws, entry, entry.room.join(msg.name));
      }
      case 'resume': {
        const entry = await this.load(msg.code);
        const player = entry?.room.players.find((p) => p.token === msg.token);
        if (!player) return this.send(ws, { type: 'expired' });
        return this.attach(ws, entry, player);
      }
    }

    const { code, playerId: me } = this.info(ws);
    const entry = code && (await this.load(code));
    if (!entry) throw new GameError('You are not in a room.');
    const { room } = entry;
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
        this.detach(ws);
        if (room.humans().length === 0) this.drop(room.code);
        return this.send(ws, { type: 'left' });
      default:
        return;
    }
    this.reap(entry);
    this.broadcast(entry);
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    try {
      await this.handle(ws, msg ?? {});
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      this.send(ws, { type: 'error', message: err instanceof GameError ? err.message : 'Something went wrong.' });
    }
  }

  async webSocketClose(ws) {
    const { code } = this.info(ws);
    if (code) await this.load(code); // after a sleep the room has to come back from storage first
    this.detach(ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  // ---------- old rooms ----------

  async scheduleCleanup() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_EVERY_MS);
  }

  // Forget rooms nobody has been connected to for a while (same limits as server.js).
  async alarm() {
    const now = Date.now();
    const saved = await this.ctx.storage.list({ prefix: 'room:' });
    for (const [key, { room, idleSince }] of saved) {
      const code = key.slice(5);
      const entry = this.rooms.get(code);
      const idle = entry ? entry.idleSince : idleSince;
      const limit = (entry?.room ?? room).phase === 'lobby' ? 30 * 60_000 : 6 * 60 * 60_000;
      if (idle != null && now - idle > limit && this.socketsIn(code).size === 0) this.drop(code);
    }
    if ((await this.ctx.storage.list({ prefix: 'room:', limit: 1 })).size) await this.ctx.storage.setAlarm(now + CLEANUP_EVERY_MS);
  }
}
