'use strict';

// Takes the README screenshots: starts the server on a spare port, plays a game
// in headless Chrome at phone size (Avijit, plus Rahul over a plain WebSocket and
// two bots) and saves each screen to docs/screenshots/.
// Run with: node scripts/screenshots.js   (needs Chrome; set CHROME to its path if it isn't found)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 3998;
const DEBUG_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const CHROME = process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- a tiny Chrome DevTools Protocol client ----------

let cdpSocket;
let nextId = 1;
const pending = new Map();

async function openChrome(profile) {
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    'about:blank',
  ]);
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await delay(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('Chrome did not start');
  cdpSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    cdpSocket.onopen = resolve;
    cdpSocket.onerror = reject;
  });
  cdpSocket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const wait = pending.get(msg.id);
    if (!wait) return;
    pending.delete(msg.id);
    if (msg.error) wait.reject(new Error(msg.error.message));
    else wait.resolve(msg.result);
  };
  return chrome;
}

function cdp(method, params = {}) {
  const id = nextId++;
  cdpSocket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function js(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(expression, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await js(`Boolean(${expression})`)) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);

// `settle` waits for the screen's entry animations to finish first.
async function shot(name, settle = 900) {
  await delay(settle);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`saved ${name}.png`);
}

// ---------- a second person, "Rahul", who plays over a plain WebSocket ----------

function rahul(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));
  let done = null;
  ws.onopen = () => send({ type: 'join', code, name: 'Rahul' });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== 'state') return;
    const { phase, round: r, you, players } = msg.state;
    const key = `${phase}:${r?.number}`;
    if (key === done) return;
    // Rahul takes his time, so each screen stays up long enough to capture.
    if (phase === 'choose' && r.babuId === you) {
      done = key;
      setTimeout(() => send({ type: 'choose', target: Math.random() < 0.5 ? 'chor' : 'dakat' }), 2500);
    } else if (phase === 'guess' && r.policeId === you) {
      done = key;
      const suspects = players.filter((p) => p.id !== r.babuId && p.id !== r.policeId);
      setTimeout(() => send({ type: 'guess', playerId: suspects[Math.floor(Math.random() * 2)].id }), 2500);
    } else if (phase === 'result') {
      done = key;
      send({ type: 'ready', value: true });
    }
  };
  return { stop: () => send({ type: 'stop', value: true }), close: () => ws.close() };
}

// ---------- the game ----------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await cdp('Emulation.setDeviceMetricsOverride', PHONE);
  await cdp('Page.navigate', { url: BASE });
  await waitFor(`document.getElementById('name')`, 'home screen');
  await js(`document.getElementById('name').value = 'Avijit'`);
  await shot('1-home');

  await click('[data-action=create]');
  await waitFor(`S.state?.phase === 'lobby'`, 'lobby');
  const friend = rahul(await js('S.state.code'));
  await waitFor(`S.state.players.length === 2`, 'Rahul in the lobby');
  await shot('2-lobby');

  // Hold the shuffle screen still for a moment so it can be captured.
  await click('[data-action=start]');
  await waitFor(`S.screen === 'shuffle'`, 'shuffle');
  await js(`S.shuffleUntil = Date.now() + 60000; render()`);
  await shot('3-shuffle', 450);
  await js(`S.shuffleUntil = 0; render()`);

  const need = new Set(['babu', 'investigating', 'chit', 'result']);
  for (let n = 1; n <= 20; n++) {
    await waitFor(`S.state.phase === 'choose' && S.state.round.number === ${n} && S.screen === 'game'`, `round ${n}`);
    const role = await js('S.state.round.yourRole');
    if (role === 'babu') {
      if (need.delete('babu')) await shot('4-babu');
      await click('[data-action=choose][data-target=chor]');
    }
    await waitFor(`S.state.phase !== 'choose'`, 'the Babu to choose');
    if (role === 'police') {
      await waitFor(`document.querySelector('[data-action=guess]')`, 'guess buttons');
      await click('[data-action=guess]');
    } else if (await js(`S.state.phase === 'guess'`)) {
      // A bot or Rahul is the Police: this is what everyone else watches.
      await waitFor(`document.querySelector('.magnifier')`, 'investigating screen');
      if (need.delete('investigating')) await shot('5-investigating', 700);
      if ((role === 'chor' || role === 'dakat') && need.delete('chit')) {
        await js(`S.peeking = true; syncPeek()`);
        await shot('6-chit', 600);
        await js(`S.peeking = false; syncPeek()`);
      }
    }
    await waitFor(`S.state.phase === 'result'`, `result ${n}`);
    if (need.delete('result')) await shot('7-result', 1600); // totals count up
    if (need.size) {
      await click('[data-action=ready]');
    } else {
      await click('[data-action=stop]');
      friend.stop();
      break;
    }
  }
  await waitFor(`S.state.phase === 'over'`, 'game over');
  await shot('8-over', 1600); // standings slide in, confetti still falling
  friend.close();
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cpdb-shots-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), BOT_DELAY_MS: '3000' },
    stdio: 'ignore',
  });
  let chrome;
  let code = 0;
  try {
    await delay(500);
    chrome = await openChrome(profile);
    await main();
  } catch (err) {
    console.error(err);
    code = 1;
  }
  chrome?.kill();
  server.kill();
  await delay(500);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(code);
})();
