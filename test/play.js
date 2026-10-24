'use strict';

// Starts the server on a spare port, plays a scripted game with 4 bot players
// and checks the rules, the scoring and that Chor/Dakat stay secret.
// Run with: npm test

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { POINTS } = require('../game');

const PORT = 3999;
const URL = `ws://localhost:${PORT}/ws`;

class Bot {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.errors = [];
    this.events = [];
    this.waiters = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = reject;
      this.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        this.events.push(msg.type);
        if (msg.type === 'joined') Object.assign(this, { code: msg.code, token: msg.token });
        if (msg.type === 'state') this.state = msg.state;
        if (msg.type === 'error') this.errors.push(msg.message);
        if (msg.type === 'state') this.onState?.();
        this.waiters = this.waiters.filter((check) => !check());
      };
    });
  }

  // Makes this player's move whenever it is their turn, picking at random.
  autoplay() {
    let done = null;
    this.onState = () => {
      const { phase, round: r, you } = this.state;
      const key = `${phase}:${r?.number}`;
      if (key === done) return;
      if (phase === 'choose' && r.babuId === you) this.send({ type: 'choose', target: Math.random() < 0.5 ? 'chor' : 'dakat' });
      else if (phase === 'guess' && r.policeId === you) {
        const suspects = this.state.players.filter((p) => p.id !== r.babuId && p.id !== r.policeId);
        this.send({ type: 'guess', playerId: suspects[Math.floor(Math.random() * 2)].id });
      } else return;
      done = key;
    };
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  until(check, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: timed out waiting for ${label}`)), 3000);
      const test = () => {
        let ok = false;
        try {
          ok = check(this);
        } catch {}
        if (ok) {
          clearTimeout(timer);
          resolve(this);
        }
        return ok;
      };
      if (!test()) this.waiters.push(test);
    });
  }

  async expectError(msg, pattern) {
    const before = this.errors.length;
    this.send(msg);
    await this.until((b) => b.errors.length > before, `an error for ${msg.type}`);
    assert.match(this.errors.at(-1), pattern);
  }

  get id() {
    return this.state.you;
  }
}

const all = (bots, check, label) => Promise.all(bots.map((b) => b.until(check, label)));

// Every bot must see only its own chit, and the four chits must be one of each role.
function checkSecrets(bots) {
  const byRole = {};
  for (const b of bots) {
    const r = b.state.round;
    assert.equal(r.roles, undefined, `${b.name} can see everyone's roles mid-round`);
    assert.equal(r.points, undefined);
    byRole[r.yourRole] = b;
  }
  assert.deepEqual(Object.keys(byRole).sort(), ['babu', 'chor', 'dakat', 'police']);
  for (const b of bots) {
    assert.equal(b.state.round.babuId, byRole.babu.id);
    assert.equal(b.state.round.policeId, byRole.police.id);
  }
  return byRole;
}

async function playRound(bots, number, target, correct, totals, beforeGuess) {
  await all(bots, (b) => b.state.phase === 'choose' && b.state.round.number === number, `round ${number}`);
  const byRole = checkSecrets(bots);

  await byRole.police.expectError({ type: 'choose', target }, /Only the Babu/);
  await byRole.babu.expectError({ type: 'choose', target: 'police' }, /Chor or Dakat/);
  byRole.babu.send({ type: 'choose', target });
  await all(bots, (b) => b.state.phase === 'guess', 'guess phase');
  for (const b of bots) assert.equal(b.state.round.target, target, 'everyone sees what the Babu selected');
  checkSecrets(bots);

  if (beforeGuess) await beforeGuess(byRole, bots);

  await byRole.babu.expectError({ type: 'guess', playerId: byRole.chor.id }, /Only the Police/);
  await byRole.police.expectError({ type: 'guess', playerId: byRole.babu.id }, /two hidden/);
  const other = target === 'chor' ? 'dakat' : 'chor';
  byRole.police.send({ type: 'guess', playerId: (correct ? byRole[target] : byRole[other]).id });
  await all(bots, (b) => ['result', 'over'].includes(b.state.phase) && b.state.round.points, `result ${number}`);

  const want = { babu: 1200, police: correct ? 900 : 0, [target]: correct ? 0 : POINTS[target], [other]: POINTS[other] };
  for (const [role, b] of Object.entries(byRole)) {
    assert.equal(bots[0].state.round.points[b.id], want[role], `round ${number}: ${role} points`);
    assert.equal(bots[0].state.round.roles[b.id], role, 'roles are revealed after the round');
    totals[b.id] = (totals[b.id] ?? 0) + want[role];
  }
  for (const p of bots[0].state.players) assert.equal(p.total, totals[p.id], `round ${number}: ${p.name} total`);
  assert.equal(bots[0].state.round.correct, correct);
  return byRole;
}

async function main() {
  const names = ['Asha', 'Bilal', 'Chitra', 'Dev'];
  const bots = await Promise.all(names.map((n) => new Bot(n).open()));
  const [a, b] = bots;

  // ----- lobby -----
  await a.expectError({ type: 'create', name: '   ' }, /name/);
  a.send({ type: 'create', name: 'Asha' });
  await a.until((x) => x.state?.phase === 'lobby', 'lobby');
  const code = a.code;
  assert.match(code, /^[A-HJ-NP-Z]{4}$/);
  for (const bot of bots.slice(1)) {
    bot.send({ type: 'join', code: code.toLowerCase(), name: bot.name });
    await bot.until((x) => x.state?.phase === 'lobby', `${bot.name} in lobby`);
  }
  await a.until((x) => x.state.players.length === 4, '4 players');
  assert.equal(a.state.hostId, a.id);

  const stranger = await new Bot('Esha').open();
  await stranger.expectError({ type: 'join', code, name: 'Esha' }, /4 players/);
  await stranger.expectError({ type: 'join', code, name: 'asha' }, /already here/);
  await stranger.expectError({ type: 'join', code: 'QQQQ', name: 'Esha' }, /No room/);
  await stranger.expectError({ type: 'start' }, /not in a room/);
  await b.expectError({ type: 'start' }, /Only the host/);

  a.send({ type: 'start' });
  const totals = {};

  // ----- round 1: Babu picks Chor, Police guesses right -----
  await playRound(bots, 1, 'chor', true, totals);
  await b.expectError({ type: 'start' }, /Only the host|already started/);
  a.send({ type: 'ready', value: true });
  await a.until((x) => x.state.players[0].ready, 'ready');
  a.send({ type: 'ready', value: false });
  await a.until((x) => !x.state.players[0].ready, 'ready undone');
  for (const bot of bots) bot.send({ type: 'ready', value: true });

  // ----- round 2: Babu picks Dakat, Police guesses wrong; players drop and come back -----
  await playRound(bots, 2, 'dakat', false, totals, async (byRole, list) => {
    // The Chor loses connection and comes back with their saved token.
    const chor = byRole.chor;
    const role = chor.state.round.yourRole;
    chor.ws.close();
    await byRole.babu.until((x) => !x.state.players.find((p) => p.id === chor.id).connected, 'chor offline');
    const back = await new Bot(chor.name).open();
    back.send({ type: 'resume', code, token: chor.token });
    await back.until((x) => x.state?.phase === 'guess', 'chor resumed');
    assert.equal(back.id, chor.id);
    assert.equal(back.state.round.yourRole, role);
    list[list.indexOf(chor)] = back;
    byRole.chor = back;

    // The Dakat loses their phone: joining with the same name gives the seat back.
    const dakat = byRole.dakat;
    dakat.ws.close();
    await byRole.babu.until((x) => !x.state.players.find((p) => p.id === dakat.id).connected, 'dakat offline');
    const phone = await new Bot(dakat.name).open();
    phone.send({ type: 'join', code, name: dakat.name.toUpperCase() });
    await phone.until((x) => x.state?.phase === 'guess', 'dakat rejoined by name');
    assert.equal(phone.id, dakat.id);
    assert.equal(phone.state.round.yourRole, 'dakat');
    list[list.indexOf(dakat)] = phone;
    byRole.dakat = phone;

    // Opening the same seat twice: the newest tab wins, the old one is told.
    const babu = byRole.babu;
    const twin = await new Bot(babu.name).open();
    twin.send({ type: 'resume', code, token: babu.token });
    await babu.until((x) => x.events.includes('replaced'), 'old tab replaced');
    await twin.until((x) => x.state?.phase === 'guess', 'twin resumed');
    list[list.indexOf(babu)] = twin;
    byRole.babu = twin;
  });
  for (const bot of bots) bot.send({ type: 'ready', value: true });

  // ----- round 3: everyone votes to stop mid-round; the round still finishes -----
  await all(bots, (x) => x.state.phase === 'choose' && x.state.round.number === 3, 'round 3');
  for (const bot of bots) bot.send({ type: 'stop', value: true });
  bots[1].send({ type: 'stop', value: false });
  await bots[0].until((x) => x.state.players.filter((p) => p.stopVote).length === 3, '3 stop votes');
  bots[1].send({ type: 'stop', value: true });
  await all(bots, (x) => x.state.players.every((p) => p.stopVote), '4 stop votes');
  assert.equal(bots[0].state.phase, 'choose', 'a round in progress is not cut short');
  await playRound(bots, 3, 'dakat', true, totals);
  await all(bots, (x) => x.state.phase === 'over', 'game over');

  const { standings, history } = bots[0].state;
  assert.equal(history.length, 3);
  for (let i = 1; i < standings.length; i++) assert.ok(standings[i - 1].total >= standings[i].total, 'standings are sorted');
  for (const s of standings) assert.equal(s.total, totals[s.id]);

  // ----- play again -----
  const host = bots.find((x) => x.id === x.state.hostId);
  const guest = bots.find((x) => x !== host);
  await guest.expectError({ type: 'restart' }, /Only the host/);
  host.send({ type: 'restart' });
  await all(bots, (x) => x.state.phase === 'lobby', 'back in lobby');
  assert.ok(bots[0].state.players.every((p) => p.total === 0 && !p.stopVote));

  // Leaving in the lobby frees the seat for someone new.
  guest.send({ type: 'leave' });
  await guest.until((x) => x.events.includes('left'), 'left');
  await host.until((x) => x.state.players.length === 3, 'seat freed');
  stranger.send({ type: 'join', code, name: 'Esha' });
  await stranger.until((x) => x.state?.phase === 'lobby', 'new player joined');

  console.log(`4 players: ${standings.map((s) => `${s.name} ${s.total}`).join(', ')}`);

  // ----- fewer than 4 people: bots fill the empty seats -----
  await botGame(['Ira']);
  await botGame(['Bot 1', 'Kabir']); // a person called "Bot 1" pushes the bots to Bot 2 and Bot 3
  console.log('All checks passed.');
}

// Points every player should get for a finished round, worked out from the revealed roles.
function expectedPoints(r) {
  const wanted = Object.keys(r.roles).find((id) => r.roles[id] === r.target);
  const correct = r.guessId === wanted;
  assert.equal(r.correct, correct);
  const want = {};
  for (const [id, role] of Object.entries(r.roles)) {
    if (role === 'police') want[id] = correct ? 900 : 0;
    else want[id] = correct && id === wanted ? 0 : POINTS[role];
  }
  return want;
}

async function botGame(names) {
  const people = await Promise.all(names.map((n) => new Bot(n).open()));
  const [host, ...rest] = people;
  host.send({ type: 'create', name: host.name });
  await host.until((x) => x.state?.phase === 'lobby', 'bot game lobby');
  for (const p of rest) {
    p.send({ type: 'join', code: host.code, name: p.name });
    await p.until((x) => x.state?.phase === 'lobby', `${p.name} in lobby`);
  }
  await host.until((x) => x.state.players.length === names.length, 'everyone joined');
  for (const p of people) p.autoplay();
  host.send({ type: 'start' });
  await all(people, (x) => x.state.phase !== 'lobby', 'bot game started');

  const players = host.state.players;
  const taken = names.map((n) => n.toLowerCase());
  const botNames = ['Bot 1', 'Bot 2', 'Bot 3', 'Bot 4'].filter((n) => !taken.includes(n.toLowerCase())).slice(0, 4 - names.length);
  assert.equal(players.length, 4);
  assert.deepEqual(players.filter((p) => p.bot).map((p) => p.name), botNames, 'empty seats get bots');
  assert.ok(players.every((p) => p.connected));
  assert.equal(host.state.hostId, host.id, 'a bot never becomes host');

  // A bot's seat can't be taken by joining with its name.
  const stranger = await new Bot('Esha').open();
  await stranger.expectError({ type: 'join', code: host.code, name: botNames[0].toUpperCase() }, /already here/);
  stranger.ws.close();

  const totals = {};
  const rounds = 4;
  for (let n = 1; n <= rounds; n++) {
    await all(people, (x) => ['result', 'over'].includes(x.state.phase) && x.state.round.number === n, `bot game result ${n}`);
    const r = host.state.round;
    assert.ok(['chor', 'dakat'].includes(r.target));
    const want = expectedPoints(r);
    for (const p of host.state.players) {
      totals[p.id] = (totals[p.id] ?? 0) + want[p.id];
      assert.equal(r.points[p.id], want[p.id], `bot game round ${n}: ${p.name} points`);
      assert.equal(p.total, totals[p.id]);
      if (p.bot) assert.ok(p.ready, 'bots are ready for the next round straight away');
    }
    if (n < rounds) {
      for (const p of people) p.send({ type: 'ready', value: true });
    } else {
      // Only people vote to stop; the bots don't hold the game up.
      for (const p of people) p.send({ type: 'stop', value: true });
    }
  }
  await all(people, (x) => x.state.phase === 'over', 'bot game over');
  assert.equal(host.state.history.length, rounds);
  assert.equal(host.state.standings.length, 4);

  // Play again: the bots leave so new friends can join.
  host.send({ type: 'restart' });
  await all(people, (x) => x.state.phase === 'lobby', 'bot game back in lobby');
  assert.deepEqual(host.state.players.map((p) => p.name), names);

  // Once every person has left, the room is gone.
  for (const p of people) p.send({ type: 'leave' });
  await all(people, (x) => x.events.includes('left'), 'everyone left');
  const late = await new Bot('Late').open();
  await late.expectError({ type: 'join', code: host.code, name: 'Late' }, /No room/);
  for (const p of [...people, late]) p.ws.close();
  console.log(`${names.join(' + ')} + ${botNames.join(' + ')}: ${rounds} rounds ok`);
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), BOT_DELAY_MS: '20' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.once('data', () => {
  main()
    .then(() => {
      server.kill();
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      server.kill();
      process.exit(1);
    });
});
