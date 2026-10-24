'use strict';

const ROLE = {
  babu: { name: 'Babu', icon: '👑', points: 1200 },
  police: { name: 'Police', icon: '👮', points: 900 },
  dakat: { name: 'Dakat', icon: '🗡️', points: 600 },
  chor: { name: 'Chor', icon: '🦹', points: 300 },
};

// How long the "shuffling the chits" screen shows before each round.
const SHUFFLE_MS = 800;

const app = document.getElementById('app');
const banner = document.getElementById('banner');
const toastBox = document.getElementById('toast');

const S = {
  ws: null,
  online: false,
  retries: 0,
  retryTimer: null,
  outbox: [],
  session: loadSession(), // { code, token } of the seat we hold
  state: null, // latest view from the server
  screen: null,
  stageKey: null,
  turnKey: null,
  peeking: false,
  shuffleUntil: 0, // time the shuffle screen ends
  replaced: false,
  open: {}, // which <details> sections are expanded, so re-renders keep them
  installPrompt: null,
};

// ---------- storage (can throw in private mode, so every call is guarded) ----------

function storage(kind) {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

// sessionStorage first so each tab keeps its own seat; localStorage so the seat
// survives the phone closing the browser.
function loadSession() {
  for (const kind of ['sessionStorage', 'localStorage']) {
    try {
      const s = JSON.parse(storage(kind)?.getItem('cpdb.session') ?? 'null');
      if (s?.code && s?.token) return s;
    } catch {}
  }
  return null;
}

function saveSession(s) {
  for (const kind of ['sessionStorage', 'localStorage']) {
    try {
      if (s) storage(kind).setItem('cpdb.session', JSON.stringify(s));
      else storage(kind).removeItem('cpdb.session');
    } catch {}
  }
}

function savedName() {
  try {
    return localStorage.getItem('cpdb.name') ?? '';
  } catch {
    return '';
  }
}

// ---------- connection ----------

function connect() {
  clearTimeout(S.retryTimer);
  if (S.ws) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.online = true;
    S.retries = 0;
    if (S.session) ws.send(JSON.stringify({ type: 'resume', ...S.session }));
    for (const msg of S.outbox.splice(0)) ws.send(JSON.stringify(msg));
    render();
  };
  ws.onmessage = (e) => receive(JSON.parse(e.data));
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.ws = null;
    S.online = false;
    render();
    if (!S.replaced) S.retryTimer = setTimeout(connect, Math.min(1000 * 2 ** S.retries++, 8000));
  };
}

function send(msg) {
  if (S.ws?.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(msg));
  } else {
    S.outbox.push(msg);
    connect();
  }
}

function receive(msg) {
  switch (msg.type) {
    case 'joined':
      S.session = { code: msg.code, token: msg.token };
      saveSession(S.session);
      history.replaceState(null, '', `/?room=${msg.code}`);
      break;
    case 'state':
      if (!S.session) return; // a late update for a room we just left
      {
        const before = S.state?.phase;
        S.state = msg.state;
        // A round just started (not a reload mid-round): shuffle the chits first.
        if (S.state.phase === 'choose' && (before === 'lobby' || before === 'result')) {
          S.shuffleUntil = Date.now() + SHUFFLE_MS;
          setTimeout(render, SHUFFLE_MS);
        }
      }
      nudgeIfMyTurn();
      break;
    case 'expired':
      leaveLocally();
      toast('That room has closed. Create or join a new one.');
      break;
    case 'left':
      leaveLocally();
      break;
    case 'replaced':
      S.replaced = true;
      S.state = null;
      break;
    case 'error':
      toast(msg.message);
      break;
  }
  render();
}

function leaveLocally() {
  S.session = null;
  S.state = null;
  saveSession(null);
  history.replaceState(null, '', '/');
}

function nudgeIfMyTurn() {
  const st = S.state;
  const r = st.round;
  const mine = Boolean(r) && ((st.phase === 'choose' && r.babuId === st.you) || (st.phase === 'guess' && r.policeId === st.you));
  const key = mine ? `${st.phase}:${r.number}` : null;
  // Chrome only allows vibrating after the player has tapped the page once.
  if (key && key !== S.turnKey && navigator.userActivation?.hasBeenActive !== false) {
    try {
      navigator.vibrate?.(200);
    } catch {}
  }
  S.turnKey = key;
  document.title = mine ? 'Your turn · CPDB' : 'CPDB';
}

// ---------- rendering ----------

function render() {
  const inRoom = Boolean(S.session || S.state);
  banner.hidden = S.online || !inRoom || S.replaced;
  app.classList.toggle('offline', !S.online && inRoom && !S.replaced);
  const st = S.state;
  if (S.replaced) show('replaced', replacedScreen());
  else if (!st) S.session ? show('loading', loadingScreen()) : showHome();
  else if (st.phase === 'lobby') show('lobby', lobbyScreen(st));
  else if (st.phase === 'over') show('over', overScreen(st));
  else if (st.phase === 'choose' && Date.now() < S.shuffleUntil) show('shuffle', shuffleScreen(st));
  else show('game', gameScreen(st));
  keepAwake();
}

function show(name, html) {
  app.innerHTML = html;
  S.screen = name;
}

// The home screen has text boxes, so it is drawn once and then left alone.
function showHome() {
  if (S.screen !== 'home') show('home', homeScreen());
  document.getElementById('install').hidden = !S.installPrompt;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function nameOf(st, id) {
  const p = st.players.find((x) => x.id === id) ?? st.standings?.find((x) => x.id === id);
  return esc(p?.name ?? 'Someone');
}

function initial(name) {
  return esc((Array.from(name)[0] ?? '?').toUpperCase());
}

const avatar = (p) => `<span class="avatar">${p.bot ? '🤖' : initial(p.name)}</span>`;

const dots = () => '<span class="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>';

const badge = (role) => `<span class="badge ${role}">${ROLE[role].icon} ${ROLE[role].name}</span>`;

function details(key, title, body, openByDefault = false) {
  return `<details data-key="${key}"${S.open[key] ?? openByDefault ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
}

function topbar(title, st) {
  return `
  <header class="topbar">
    <button class="link" data-action="leave">✕ Leave</button>
    <span class="title">${title}</span>
    <span class="code-pill">${esc(st.code)}</span>
  </header>`;
}

function homeScreen() {
  const code = (new URLSearchParams(location.search).get('room') ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  return `
  <main class="screen home">
    <header class="brand">
      <div class="tiles" aria-hidden="true"><span class="chor">C</span><span class="police">P</span><span class="dakat">D</span><span class="babu">B</span></div>
      <h1>CPDB</h1>
      <p class="tagline">Chor · Police · Dakat · Babu</p>
    </header>
    <section class="panel">
      <label class="field">Your name
        <input id="name" maxlength="16" autocomplete="nickname" enterkeyhint="go" placeholder="Type your name" value="${esc(savedName())}">
      </label>
      <button class="btn big${code ? '' : ' primary'}" data-action="create">Create a room</button>
      <div class="divider">or join a friend</div>
      <div class="join-row">
        <input id="code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" placeholder="CODE" aria-label="Room code" value="${code}">
        <button class="btn${code ? ' primary' : ''}" data-action="join">Join</button>
      </div>
    </section>
    <button class="btn ghost" id="install" data-action="install" hidden>📲 Install CPDB on this phone</button>
    ${rules()}
  </main>`;
}

function loadingScreen() {
  return `
  <main class="screen">
    <section class="panel center">
      <p class="eyebrow">Room ${esc(S.session.code)}</p>
      <h2>Rejoining${dots()}</h2>
      <button class="link" data-action="forget">Go to the start screen</button>
    </section>
  </main>`;
}

function replacedScreen() {
  return `
  <main class="screen">
    <section class="panel center">
      <h2>This game is open somewhere else</h2>
      <p class="hint">Your seat was opened on another tab or phone.</p>
      <button class="btn primary big" data-action="playHere">Play here instead</button>
    </section>
  </main>`;
}

function lobbyScreen(st) {
  const isHost = st.hostId === st.you;
  const missing = 4 - st.players.length;
  const away = st.players.find((p) => !p.connected);
  const bots = `${missing} bot${missing > 1 ? 's' : ''}`;
  let footer;
  if (away) footer = `<p class="hint">Waiting for ${esc(away.name)} to come back${dots()}</p>`;
  else if (isHost && missing) footer = `<p class="hint">Wait for friends, or start now and ${bots} will play the empty seat${missing > 1 ? 's' : ''}.</p>`;
  else if (isHost) footer = '<p class="hint">Everyone is here!</p>';
  else footer = `<p class="hint">Waiting for ${nameOf(st, st.hostId)} to start${dots()}</p>`;
  const label = missing ? `Start with ${bots} 🤖` : 'Start game';
  if (isHost) footer += `<button class="btn primary big" data-action="start"${away ? ' disabled' : ''}>${label}</button>`;
  const seats = [0, 1, 2, 3].map((i) => seat(st, st.players[i], isHost)).join('');
  return `
  <main class="screen lobby">
    ${topbar('Lobby', st)}
    <section class="panel center">
      <p class="eyebrow">Room code</p>
      <p class="room-code">${esc(st.code)}</p>
      <p class="hint">Friends tap Join and type this code.</p>
      <button class="btn" data-action="share">Share invite link</button>
    </section>
    <ul class="seats">${seats}</ul>
    <footer class="dock">${footer}</footer>
    ${rules()}
  </main>`;
}

function seat(st, p, isHost) {
  if (!p) return '<li class="seat empty"><span class="avatar">?</span><span class="who">Empty seat · a bot plays if nobody joins</span></li>';
  const tags = [];
  if (p.id === st.you) tags.push('<span class="you">you</span>');
  if (p.id === st.hostId) tags.push('<span class="tag">host</span>');
  if (!p.connected) tags.push('<span class="tag off">offline</span>');
  const remove = isHost && !p.connected ? `<button class="btn small" data-action="kick" data-id="${p.id}">Remove</button>` : '';
  return `
  <li class="seat${p.id === st.you ? ' me' : ''}${p.connected ? '' : ' away'}">
    ${avatar(p)}
    <span class="who"><span class="name">${esc(p.name)}</span>${tags.join('')}</span>
    ${remove}
  </li>`;
}

// Four face-down chits swapping places while the server's deal is "decided".
function shuffleScreen(st) {
  const chits = ['chor', 'police', 'dakat', 'babu'].map((role) => `<span class="${role}">?</span>`).join('');
  return `
  <main class="screen game">
    ${topbar(`Round ${st.round.number}`, st)}
    <section class="stage shuffle">
      <div class="deck" aria-hidden="true">${chits}</div>
      <h2>Shuffling the chits${dots()}</h2>
      <p>Everyone gets a new role.</p>
    </section>
  </main>`;
}

function gameScreen(st) {
  const r = st.round;
  const key = `${st.phase}:${r.number}`;
  const enter = key !== S.stageKey ? ' enter' : '';
  S.stageKey = key;
  return `
  <main class="screen game">
    ${topbar(`Round ${r.number}`, st)}
    <ul class="board">${st.players.map((p) => boardRow(st, p)).join('')}</ul>
    <section class="stage${enter}">${stage(st)}</section>
    ${st.phase === 'result' ? '' : myChit(st)}
    <footer class="dock">${stopButton(st)}</footer>
    ${scoreSheet(st)}
    ${rules()}
  </main>`;
}

function boardRow(st, p) {
  const r = st.round;
  const revealed = st.phase === 'result';
  // Babu and Police are public; Chor and Dakat show as "?" until the round ends,
  // even on your own row, so nobody can read your role off your screen.
  const role = revealed ? r.roles[p.id] : p.id === r.babuId ? 'babu' : p.id === r.policeId ? 'police' : null;
  const tags = [];
  if (p.id === st.you) tags.push('<span class="you">you</span>');
  if (!p.connected) tags.push('<span class="tag off">offline</span>');
  if (revealed && p.ready) tags.push('<span class="mark" title="Ready">✓</span>');
  if (p.stopVote) tags.push('<span class="mark stop" title="Voted to stop">✋</span>');
  const pts = revealed ? r.points[p.id] : null;
  return `
  <li class="row${p.id === st.you ? ' me' : ''}${p.connected ? '' : ' away'}">
    ${avatar(p)}
    <span class="who"><span class="name">${esc(p.name)}</span>${tags.join('')}</span>
    ${role ? badge(role) : '<span class="badge">?</span>'}
    <span class="score">${pts === null ? '' : `<span class="delta${pts ? '' : ' zero'}">+${pts}</span>`}${p.total}</span>
  </li>`;
}

function stage(st) {
  const r = st.round;
  const babu = nameOf(st, r.babuId);
  const police = nameOf(st, r.policeId);

  if (st.phase === 'choose') {
    if (st.you === r.babuId) {
      const option = (role) => `
        <button class="btn role-btn ${role}" data-action="choose" data-target="${role}">
          <span class="icon">${ROLE[role].icon}</span>${ROLE[role].name}<small>${ROLE[role].points} pts</small>
        </button>`;
      return `
        <p class="eyebrow">You're the Babu</p>
        <h2>👑 1200 points are yours!</h2>
        <p>Who should <b>${police}</b> (Police) find?</p>
        <div class="choices">${option('chor')}${option('dakat')}</div>`;
    }
    if (st.you === r.policeId) {
      return `
        <p class="eyebrow">You're the Police 👮</p>
        <h2>👑 ${babu} is choosing${dots()}</h2>
        <p>Chor or Dakat? Get ready to find them.</p>`;
    }
    return `
      <p class="eyebrow">Round ${r.number}</p>
      <h2>👑 ${babu} is the Babu</h2>
      <p>Choosing who <b>${police}</b> (Police) must find${dots()}</p>`;
  }

  if (st.phase === 'guess') {
    const target = ROLE[r.target];
    const suspects = st.players.filter((p) => p.id !== r.babuId && p.id !== r.policeId);
    const head = `<p class="announce">Babu selected <span class="${r.target}">${target.icon} ${target.name}</span></p>`;
    if (st.you === r.policeId) {
      return `${head}
        <h2>🔍 Investigate: who is the ${target.name}?</h2>
        <div class="choices">${suspects.map((p) => `<button class="btn suspect" data-action="guess" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>
        <p class="hint">Right guess: you get 900. Wrong guess: you get 0.</p>`;
    }
    // Everyone else watches the Police investigate the two hidden players.
    const chip = (p) => `<span class="suspect-chip">${p.id === st.you ? 'You' : esc(p.name)}</span>`;
    return `${head}
      <div class="magnifier" aria-hidden="true">🔍</div>
      <h2>👮 ${police} is investigating${dots()}</h2>
      <div class="suspects">${chip(suspects[0])}<span class="or">or</span>${chip(suspects[1])}</div>
      <p>Who is the ${target.name}?</p>`;
  }

  const res = resultText(st);
  const me = st.players.find((p) => p.id === st.you);
  const waiting = st.players.filter((p) => !p.ready).map((p) => esc(p.name));
  return `
    <p class="eyebrow">Babu wanted the ${ROLE[r.target].name}</p>
    <h2 class="${res.cls}">${res.head}</h2>
    <p>${res.text}</p>
    <button class="btn big${me.ready ? '' : ' primary'}" data-action="ready" data-value="${!me.ready}">${me.ready ? 'Ready ✓ · tap to undo' : 'Next round ▶'}</button>
    <p class="hint">${waiting.length ? `Waiting for ${waiting.join(', ')}` : ''}</p>`;
}

function resultText(st) {
  const r = st.round;
  const target = ROLE[r.target];
  const other = ROLE[r.target === 'chor' ? 'dakat' : 'chor'];
  const police = nameOf(st, r.policeId);
  const wanted = nameOf(st, Object.keys(r.roles).find((id) => r.roles[id] === r.target));
  if (r.correct) {
    return { head: '🚨 Caught!', cls: 'good', text: `${police} found the ${target.name}. <b>${wanted}</b> gets 0 this round.` };
  }
  return {
    head: '💨 Wrong guess!',
    cls: 'bad',
    text: `${police} picked <b>${nameOf(st, r.guessId)}</b>, who was the ${other.name}. The ${target.name} was <b>${wanted}</b>. Police gets 0.`,
  };
}

function myChit(st) {
  const r = st.round;
  const role = r.yourRole;
  if (role !== 'chor' && role !== 'dakat') return '';
  let note = `${ROLE[role].points} points, unless the Police catches you`;
  if (st.phase === 'guess') {
    note = r.target === role ? 'The Police is hunting you. Poker face! 😐' : `You're safe this round: ${ROLE[role].points} points`;
  }
  return `
  <section class="chit ${role}${S.peeking ? ' peeking' : ''}" data-peek>
    <div class="chit-cover">🤫 Your secret chit<small>Press and hold to peek</small></div>
    <div class="chit-face"><span class="icon">${ROLE[role].icon}</span><b>${ROLE[role].name}</b><small>${note}</small></div>
  </section>`;
}

function stopButton(st) {
  const me = st.players.find((p) => p.id === st.you);
  // Bots don't vote; the people playing decide when to stop.
  const people = st.players.filter((p) => !p.bot).length;
  const votes = st.players.filter((p) => p.stopVote).length;
  const note = votes === people ? '<p class="hint">Everyone voted to stop. The game ends after this round.</p>' : '';
  const label = me.stopVote ? `✋ You voted to stop (${votes}/${people}) · tap to undo` : `✋ Vote to stop the game (${votes}/${people})`;
  return `${note}<button class="btn ghost${me.stopVote ? ' on' : ''}" data-action="stop" data-value="${!me.stopVote}">${label}</button>`;
}

function scoreSheet(st, openByDefault = false) {
  if (!st.history.length) return '';
  const people = st.standings ?? st.players;
  const rows = st.history
    .slice()
    .reverse()
    .map((h) => `<tr><td>R${h.number}</td>${people.map((p) => `<td><span class="ri">${ROLE[h.roles[p.id]].icon}</span>${h.points[p.id]}</td>`).join('')}</tr>`)
    .join('');
  const n = st.history.length;
  return details('sheet', `Score sheet · ${n} round${n > 1 ? 's' : ''}`, `
    <table>
      <thead><tr><th></th>${people.map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th>Total</th>${people.map((p) => `<th>${p.total}</th>`).join('')}</tr></tfoot>
    </table>`, openByDefault);
}

function overScreen(st) {
  const ranked = st.standings;
  const best = ranked[0].total;
  const winners = ranked.filter((p) => p.total === best);
  const isHost = st.hostId === st.you;
  const medals = ['🥇', '🥈', '🥉'];
  const list = ranked
    .map((p) => {
      const rank = ranked.filter((q) => q.total > p.total).length;
      const cls = [rank === 0 && 'first', p.id === st.you && 'me'].filter(Boolean).join(' ');
      return `<li class="${cls}"><span class="medal">${medals[rank] ?? rank + 1}</span><span class="name">${esc(p.name)}</span><span class="score">${p.total}</span></li>`;
    })
    .join('');
  const rounds = st.history.length;
  const res = resultText(st);
  const headline = winners.length > 1 ? "It's a tie!" : `${esc(winners[0].name)} wins!`;
  const summary = winners.length > 1 ? `${winners.map((w) => esc(w.name)).join(' & ')} share the top spot with ${best}` : `${best} points`;
  return `
  <main class="screen over">
    ${topbar('Game over', st)}
    <section class="panel center trophy">
      <div class="big-icon">🏆</div>
      <h2>${headline}</h2>
      <p>${summary} after ${rounds} round${rounds > 1 ? 's' : ''}</p>
    </section>
    <ol class="standings">${list}</ol>
    <section class="panel last-round">
      <p class="eyebrow">Last round</p>
      <p><b class="${res.cls}">${res.head}</b> ${res.text}</p>
    </section>
    <footer class="dock">${
      isHost ? '<button class="btn primary big" data-action="restart">Play again</button>' : `<p class="hint">Waiting for ${nameOf(st, st.hostId)} to start a new game${dots()}</p>`
    }</footer>
    ${scoreSheet(st, true)}
  </main>`;
}

function rules() {
  return details('rules', 'How to play', `
    <ol>
      <li>4 players. Fewer than 4 of you? Bots 🤖 fill the empty seats.</li>
      <li>Every round each player gets a random chit: 👑 Babu 1200 · 👮 Police 900 · 🗡️ Dakat 600 · 🦹 Chor 300.</li>
      <li>Everyone sees who is Babu and who is Police. Chor and Dakat stay secret.</li>
      <li>The Babu gets 1200 for free and picks who the Police must find: the Chor or the Dakat.</li>
      <li>The Police guesses which of the two hidden players has that chit.</li>
      <li>Right guess: Police gets 900, the caught player gets 0, the other keeps their points.</li>
      <li>Wrong guess: Police gets 0, Chor and Dakat both keep their points.</li>
      <li>Play as many rounds as you like. When all the players (not the bots) vote to stop, the highest total wins.</li>
    </ol>`);
}

function toast(text, ms = 3000) {
  toastBox.textContent = text;
  toastBox.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastBox.classList.remove('show'), ms);
}

// ---------- actions ----------

function readName() {
  const input = document.getElementById('name');
  const name = input.value.trim();
  if (!name) {
    toast('Enter your name first');
    input.focus();
    return null;
  }
  try {
    localStorage.setItem('cpdb.name', name);
  } catch {}
  return name;
}

function readCode() {
  const input = document.getElementById('code');
  const code = input.value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Enter the 4-letter room code');
    input.focus();
    return null;
  }
  return code;
}

// For one-shot buttons: stop a double tap from sending twice.
function once(el, msg) {
  el.disabled = true;
  send(msg);
}

const actions = {
  create() {
    const name = readName();
    if (name) send({ type: 'create', name });
  },
  join() {
    const name = readName();
    const code = name && readCode();
    if (code) send({ type: 'join', code, name });
  },
  start: (el) => once(el, { type: 'start' }),
  choose: (el) => once(el, { type: 'choose', target: el.dataset.target }),
  guess: (el) => once(el, { type: 'guess', playerId: el.dataset.id }),
  restart: (el) => once(el, { type: 'restart' }),
  kick: (el) => once(el, { type: 'kick', playerId: el.dataset.id }),
  ready: (el) => send({ type: 'ready', value: el.dataset.value === 'true' }),
  stop: (el) => send({ type: 'stop', value: el.dataset.value === 'true' }),
  leave() {
    const midGame = S.state && !['lobby', 'over'].includes(S.state.phase);
    if (midGame && !confirm('Leave this game? You can come back by joining the same room with the same name.')) return;
    if (S.online) S.ws.send(JSON.stringify({ type: 'leave' }));
    leaveLocally();
    render();
  },
  forget() {
    leaveLocally();
    render();
  },
  playHere() {
    S.replaced = false;
    S.retries = 0;
    connect();
    render();
  },
  async share() {
    const code = S.state.code;
    const url = `${location.origin}/?room=${code}`;
    const text = `Join my CPDB game! Room code: ${code}`;
    if (navigator.share) {
      try {
        return await navigator.share({ title: 'CPDB', text, url });
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('Invite link copied');
    } catch {
      toast(`Tell your friends: room ${code} at ${url}`, 6000);
    }
  },
  async install() {
    const prompt = S.installPrompt;
    S.installPrompt = null;
    document.getElementById('install').hidden = true;
    await prompt?.prompt();
  },
};

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && !el.disabled) actions[el.dataset.action]?.(el);
});

app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'code') actions.join();
  if (e.target.id === 'name') (document.getElementById('code').value ? actions.join : actions.create)();
});

app.addEventListener('input', (e) => {
  if (e.target.id === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
});

app.addEventListener('toggle', (e) => {
  if (e.target.dataset?.key) S.open[e.target.dataset.key] = e.target.open;
}, true);

// ---------- press and hold to peek at your chit ----------

function syncPeek() {
  app.querySelector('[data-peek]')?.classList.toggle('peeking', S.peeking);
}

function stopPeek() {
  if (!S.peeking) return;
  S.peeking = false;
  syncPeek();
}

app.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('[data-peek]')) return;
  S.peeking = true;
  syncPeek();
});
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, stopPeek);
window.addEventListener('blur', stopPeek);
app.addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-peek]')) e.preventDefault();
});

// ---------- phone niceties ----------

let wakeLock = null;
let wakePending = false;

// Keep the screen on while in a room, so the phone doesn't sleep mid-round.
async function keepAwake() {
  if (!('wakeLock' in navigator) || wakePending) return;
  const want = Boolean(S.state) && S.state.phase !== 'over' && document.visibilityState === 'visible';
  wakePending = true;
  try {
    if (want && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
  wakePending = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return stopPeek();
  if (!S.ws && !S.replaced) {
    S.retries = 0;
    connect();
  }
  keepAwake();
});

// Free hosting plans put the server to sleep when no web requests arrive, and
// WebSocket messages may not count. A game in progress keeps it awake.
setInterval(() => {
  if (S.state) fetch('/healthz', { cache: 'no-store' }).catch(() => {});
}, 4 * 60_000);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  S.installPrompt = e;
  const button = document.getElementById('install');
  if (button) button.hidden = false;
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

connect();
render();
