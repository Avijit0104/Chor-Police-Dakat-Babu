'use strict';

// Game rules for CPDB (Chor Police Dakat Babu). No networking here: server.js
// calls these methods and sends each player the result of viewFor().

const crypto = require('crypto');

const POINTS = { babu: 1200, police: 900, dakat: 600, chor: 300 };
const ROLES = Object.keys(POINTS);
const SEATS = 4;
const NAME_MAX = 16;

// An error whose message is safe to show to the player.
class GameError extends Error {}

function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!name) throw new GameError('Enter your name first.');
  return name;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = []; // { id, token, name, connected, total, ready, stopVote }
    this.hostId = null;
    this.phase = 'lobby'; // lobby -> choose -> guess -> result -> choose ... -> over
    this.round = null;
    this.history = [];
    this.standings = null;
    this.nextId = 1;
  }

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  holderOf(role) {
    return Object.keys(this.round.roles).find((id) => this.round.roles[id] === role);
  }

  // The host can drop off; whoever is still connected takes over host buttons.
  effectiveHostId() {
    const host = this.player(this.hostId);
    if (host?.connected) return host.id;
    return (this.players.find((p) => p.connected) ?? host)?.id ?? null;
  }

  requireHost(id) {
    if (id !== this.effectiveHostId()) throw new GameError('Only the host can do that.');
  }

  join(rawName) {
    const name = cleanName(rawName);
    const same = this.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (same) {
      // Same name on an empty seat: that player is coming back on a new tab or phone.
      if (same.connected) throw new GameError(`Someone called "${same.name}" is already here. Pick another name.`);
      same.token = crypto.randomUUID();
      return same;
    }
    if (this.phase !== 'lobby') throw new GameError('This game has already started.');
    if (this.players.length >= SEATS) throw new GameError('This room already has 4 players.');
    const player = {
      id: `p${this.nextId++}`,
      token: crypto.randomUUID(),
      name,
      connected: false,
      total: 0,
      ready: false,
      stopVote: false,
    };
    this.players.push(player);
    this.hostId ??= player.id;
    return player;
  }

  remove(id) {
    this.players = this.players.filter((p) => p.id !== id);
    if (this.hostId === id) this.hostId = this.players[0]?.id ?? null;
  }

  // Mid-game the seat is kept, so the player can rejoin with the same name.
  leave(id) {
    if (this.phase === 'lobby' || this.phase === 'over') this.remove(id);
  }

  kick(byId, targetId) {
    this.requireHost(byId);
    if (this.phase !== 'lobby') throw new GameError('Players can only be removed in the lobby.');
    const target = this.player(targetId);
    if (!target || target.id === byId) throw new GameError('That player is not in the room.');
    if (target.connected) throw new GameError(`${target.name} is still connected.`);
    this.remove(target.id);
  }

  start(byId) {
    this.requireHost(byId);
    if (this.phase !== 'lobby') throw new GameError('The game has already started.');
    if (this.players.length < SEATS) throw new GameError('You need 4 players to start.');
    const away = this.players.find((p) => !p.connected);
    if (away) throw new GameError(`Waiting for ${away.name} to reconnect.`);
    this.newRound();
  }

  newRound() {
    const roles = shuffle(ROLES);
    this.round = { number: this.history.length + 1, roles: {}, target: null, guessId: null, correct: null, points: null };
    this.players.forEach((p, i) => {
      this.round.roles[p.id] = roles[i];
      p.ready = false;
    });
    this.phase = 'choose';
  }

  choose(byId, target) {
    if (this.phase !== 'choose') throw new GameError('It is not time to choose.');
    if (this.holderOf('babu') !== byId) throw new GameError('Only the Babu can choose.');
    if (target !== 'chor' && target !== 'dakat') throw new GameError('Choose Chor or Dakat.');
    this.round.target = target;
    this.phase = 'guess';
  }

  guess(byId, suspectId) {
    if (this.phase !== 'guess') throw new GameError('It is not time to guess.');
    if (this.holderOf('police') !== byId) throw new GameError('Only the Police can guess.');
    const role = this.round.roles[suspectId];
    if (role !== 'chor' && role !== 'dakat') throw new GameError('Pick one of the two hidden players.');
    this.resolve(suspectId);
  }

  resolve(suspectId) {
    const r = this.round;
    const wantedId = this.holderOf(r.target);
    r.guessId = suspectId;
    r.correct = suspectId === wantedId;
    r.points = {};
    for (const p of this.players) {
      const role = r.roles[p.id];
      const lost = (role === 'police' && !r.correct) || (r.correct && p.id === wantedId);
      r.points[p.id] = lost ? 0 : POINTS[role];
      p.total += r.points[p.id];
    }
    this.history.push({ number: r.number, roles: r.roles, points: r.points });
    this.phase = 'result';
    if (this.everyone('stopVote')) this.finish();
  }

  everyone(flag) {
    return this.players.every((p) => p[flag]);
  }

  setReady(byId, value) {
    if (this.phase !== 'result') return;
    this.player(byId).ready = !!value;
    if (this.everyone('ready')) this.newRound();
  }

  // A round in progress always finishes; the game ends once its result is in.
  voteStop(byId, value) {
    if (!['choose', 'guess', 'result'].includes(this.phase)) return;
    this.player(byId).stopVote = !!value;
    if (this.phase === 'result' && this.everyone('stopVote')) this.finish();
  }

  finish() {
    this.phase = 'over';
    this.standings = this.players
      .map(({ id, name, total }) => ({ id, name, total }))
      .sort((a, b) => b.total - a.total);
  }

  restart(byId) {
    this.requireHost(byId);
    if (this.phase !== 'over') throw new GameError('The game is still going.');
    for (const p of this.players) Object.assign(p, { total: 0, ready: false, stopVote: false });
    this.round = null;
    this.history = [];
    this.standings = null;
    this.phase = 'lobby';
  }

  // What one player may see. Who is Chor and who is Dakat stays off the wire
  // until the round is over; each player only learns their own chit.
  viewFor(id) {
    const r = this.round;
    let round = null;
    if (r) {
      round = {
        number: r.number,
        babuId: this.holderOf('babu'),
        policeId: this.holderOf('police'),
        yourRole: r.roles[id] ?? null,
        target: r.target,
      };
      if (this.phase === 'result' || this.phase === 'over') {
        Object.assign(round, { roles: r.roles, guessId: r.guessId, correct: r.correct, points: r.points });
      }
    }
    return {
      code: this.code,
      phase: this.phase,
      you: id,
      hostId: this.effectiveHostId(),
      players: this.players.map(({ id, name, connected, total, ready, stopVote }) => ({ id, name, connected, total, ready, stopVote })),
      round,
      history: this.history,
      standings: this.standings,
    };
  }
}

module.exports = { Room, GameError, POINTS, SEATS };
