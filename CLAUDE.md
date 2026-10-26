# CPDB: project notes for Claude

**Keep this file current.** Whenever you change a rule, a screen, a file, how it is run or hosted, or a decision below, update the matching section in the same change and add a line to the Changelog. A new session should be able to pick up from this file alone. Keep `README.md` (the player-facing guide) in sync too, and retake its screenshots with `node scripts/screenshots.js` when a screen changes visibly.

## What this is

CPDB (Chor Police Dakat Babu) is a 4-player chit game the owner designed to play with friends on their phones:

- on the same Wi-Fi, and
- online from different networks, joining with a room code.

It has to cost nothing to build, host and play.

## Game rules (as the owner specified them)

- Exactly 4 players. Each round every player gets a random role (chit):
  - Babu 1200
  - Police 900
  - Dakat 600
  - Chor 300
- The Babu always gets 1200 points.
- Everyone sees who is Babu and who is Police. Chor and Dakat are known only to the player holding them.
- The Babu selects Chor or Dakat, and everyone is told, worded like "Babu selected Chor".
- The Police guesses which of the two hidden players holds the selected role.
  - **Right guess:** Police gets 900, the caught player gets 0, the unselected one keeps their points.
  - **Wrong guess:** Police gets 0, Chor and Dakat both get their points.
- Rounds repeat. When all 4 players vote to stop, the game ends and the highest total wins.
- With fewer than 4 people, bots fill the empty seats (details below).

### Choices made where the rules were silent (the owner can change these)

- **Stop vote:** can be cast or undone at any time during play, and stays until undone. If all 4 vote mid-round, that round finishes first, then the game ends.
- **Next round:** starts when all 4 tap "Next round" on the result screen.
- **Babu's view:** the Babu does not learn who is Chor or Dakat before choosing.
- **Ties:** players share the win. Standings use 1, 2, 3, 3 style ranking.
- **Starting:** the host can start with 1 to 4 people, as long as everyone in the lobby is connected. In the lobby, the host can remove a player who is offline.
- **Bots (added at the owner's request):** at start, empty seats are filled with bots named `Bot 1`, `Bot 2`, `Bot 3`, skipping any name a person already uses.
  - Bots take part like players: they get chits and points and can win.
  - A Babu bot picks Chor or Dakat at random, and a Police bot guesses one of the two at random, so bots know no more than a person would. They move after a 1.2–2.4 s pause.
  - Bots are ready for the next round straight away and never vote to stop. The stop vote and "Next round" wait only for the people.
  - Bots are always "connected", so nobody can take a bot's seat by joining with its name, and a bot never becomes host.
  - Play again removes the bots, so new friends can join; empty seats are filled again at the next start.
  - A room with only bots left in it (everyone left after the game) is deleted.
- **Rejoining by name:** joining with the same name as an offline seat takes that seat back. This covers a lost or switched phone. Names are unique per room, ignoring case, max 16 characters.
- **Leaving:** leaving mid-game keeps the seat for a rejoin; leaving in the lobby or after the game frees it.
- **Play again:** the host's button resets scores and goes back to the lobby with the same players.
- **Hidden roles on screen:** Chor/Dakat players see "?" on the board even for themselves. They press and hold their chit to peek.

## Decisions and why

- **Web app (PWA), not a native APK.** The game is turn-based, so a browser is enough. Android installs it from Chrome (only over `https`). This avoids sideloading APKs and Google's developer-verification rules. Updates reach everyone instantly, and iPhones work too.
- **One Node.js server for both Wi-Fi and online play.** It serves the page and runs rooms over WebSockets. Players on the same Wi-Fi just use room codes like everyone else.
  - Trade-off: there is no offline phone-hosts-phone mode, because a browser can't run a server. For no-internet play, a PC on the same Wi-Fi or hotspot runs the server.
- **The server is authoritative.** Who holds Chor and Dakat is never sent to other phones until the round ends, so inspecting the page can't reveal it.
- **No peer-to-peer.** It often fails on mobile networks.
- **Hosting: Render free plan**, live at `https://chor-police-dakat-babu.onrender.com` (web service `Chor-Police-Dakat-Babu`, ID `srv-dbe6mt9srm7s73b3esr0`, in the owner's Render workspace). It was set up as a plain Web Service connected to the GitHub repo, not through `render.yaml`, so settings changed in the Render dashboard win over that file. Every push to `main` redeploys automatically, which restarts the server and drops any rooms in progress.
  - Catches: it sleeps after 15 minutes idle and takes about a minute to wake. Rooms live in memory and are lost when it sleeps or restarts.
  - The client fetches `/healthz` every 4 minutes during a game so it doesn't sleep mid-game.
  - Quick alternative: `cloudflared tunnel --url http://localhost:3000` gives a temporary `https` link while the PC is on.
- **Plain HTML/CSS/JS, no framework or build step.** The only dependency is `ws`. The page also loads the free "Fredoka" font from Google Fonts for headings and buttons; without a connection it falls back to the system font.
- **Code lives on GitHub:** public repository `https://github.com/Avijit0104/Chor-Police-Dakat-Babu`, branch `main`. Commits use the identity `Avijit0104 <191544536+Avijit0104@users.noreply.github.com>` (GitHub's private email, set in this repo's git config only). Pushing signs in through Git Credential Manager in the browser; the GitHub CLI (`gh`) is not installed.

## Files

| File | Purpose |
|---|---|
| `game.js` | `Room` class: all rules, scoring, bots' moves (`botMove()`) and per-player views. No networking or timers. |
| `server.js` | Static file server for `public/`, WebSocket server at `/ws`, rooms map, reconnects, heartbeat, idle-room cleanup, `/healthz`, and the timer that runs bot moves. |
| `public/index.html` | Page shell, including the "Created by Avijit Bose" credit under `#app`, so it shows on every screen. |
| `public/style.css` | All styles and animations. Dark theme, mobile-first, max width 480px. |
| `public/app.js` | The whole client: connection, rendering, actions, peek, wake lock, install button. |
| `public/manifest.webmanifest`, `public/sw.js` | Make it installable. The service worker is network-first with cache `cpdb-v1`; bump the name if caching changes. |
| `public/icon-*.png` | App icons, generated by `scripts/make-icons.ps1` (Windows `System.Drawing`). |
| `test/play.js` | Starts the server on port 3999 (with `BOT_DELAY_MS=20`) and has 4 scripted test players play 3 rounds. It checks scoring, secrecy of Chor/Dakat, error cases, reconnect, rejoin by name, tab takeover, stop vote, play again and leaving. Then it plays 4-round games with 1 person + 3 bots and 2 people + 2 bots (one person named "Bot 1"), checking bot names, scoring, that bots can't be taken over, people-only stop votes, bots leaving on play again, and room deletion. |
| `render.yaml` | Render blueprint: free plan, `npm install`, `npm start`, health check `/healthz`. |
| `README.md` | Player-facing guide: play link, screenshots, how to start, rules, bots, Android home screen, good-to-know. At the owner's request it says nothing about running or hosting the server (that lives here). |
| `docs/screenshots/*.png` | The 8 README screenshots, 390×844 at 2× scale. |
| `scripts/screenshots.js` | Retakes those screenshots: starts the server on port 3998 (`BOT_DELAY_MS=3000`), drives headless Chrome over the DevTools protocol (no extra dependency; `CHROME` env variable overrides the path), and plays as Avijit with "Rahul" on a plain WebSocket and 2 bots. Run `node scripts/screenshots.js`. |

## How it works

### Phases (in `game.js`)

`lobby` → `choose` (Babu picks) → `guess` (Police picks) → `result` → `choose` of the next round … → `over`

- `Room.viewFor(id)` builds what one player may see.
- `round.roles`, `guessId`, `correct` and `points` are only included in `result` and `over`.
- `standings` is frozen when the game ends.

### Messages

**Client → server:**
- `create {name}`
- `join {code, name}`
- `resume {code, token}`
- `start`
- `choose {target: "chor"|"dakat"}`
- `guess {playerId}`
- `ready {value}`
- `stop {value}`
- `restart`
- `kick {playerId}`
- `leave`

**Server → client:**
- `joined {code, token}`
- `state {state}`
- `error {message}`
- `expired` (resume failed: the room is gone)
- `left`
- `replaced` (the same seat was opened in another tab or phone; the newest one wins)

**State shape:**
- `{code, phase, you, hostId, players, round, history, standings}`
- `players[i]`: `{id, name, bot, connected, total, ready, stopVote}`
- `round`: `{number, babuId, policeId, yourRole, target}`, plus `roles`, `guessId`, `correct`, `points` after the round
- `history[i]`: `{number, roles, points}`

### Server details

- Room codes are 4 letters, without I or O.
- Pings every 25s drop dead connections.
- Empty rooms are deleted after 30 minutes in the lobby, or 6 hours otherwise.
- Room limit: 2000. Message size limit: 4 KB.
- `PORT` env variable, default 3000. On start it prints the LAN addresses phones can use.
- Bots: after every `broadcast()`, `runBots()` checks `room.botMove()`. If a bot must move, it waits `BOT_DELAY_MS` (env variable; default a random 1.2–2.4 s), makes the move and broadcasts again. There is one timer per room.

### Client details (`public/app.js`)

- **Seat storage:** the seat `{code, token}` is saved under the key `cpdb.session`, in `sessionStorage` first (one seat per tab) and `localStorage` second (survives the browser closing). The player's name is saved under `cpdb.name`.
- **Reconnecting:** automatic, with a 1–8s backoff. It resumes the seat on reconnect and reconnects right away when the page becomes visible again.
- **Rendering:** `render()` redraws `#app` from the latest state using template strings. The home screen is drawn once so its text boxes aren't wiped. Clicks are handled through `data-action` attributes.
- **Animations (added 2026-10-26 at the owner's request):**
  - Since every update redraws everything, `show(name, build, key)` sets `S.fresh` and the `#app.fresh` class only when `key` changes. The key is the screen, or the phase and round in a game. Entry animations in `style.css` are all scoped to `#app.fresh`, so they play once and not on every stop vote or reconnect. Looping animations (glows, bobbing, the magnifier) are not scoped.
  - Entry animations by screen:
    - Screens rise in one block after another.
    - Lobby: room-code letters pop, and seats slide in. `S.seen` makes later joiners slide in alone.
    - New round: board rows are dealt in, and the shuffle chits deal then swap.
    - Result: badges flip face up, `+points` float up, and totals count up (`countUp()`, using `data-from`). The headline lands like a stamp. "Caught!" flashes red and blue police lights (`.siren`), and the caught row shakes.
    - Game over: confetti (`confetti()`, 48 pieces, only when fresh), the trophy springs in with spinning rays, standings slide in, and first place shines. The winner's own phone says "You win! 🎉".
  - Always on:
    - Drifting role-coloured glows behind everything (`.bg` in `index.html`).
    - A shine sweep on primary buttons.
    - The acting player's row (Babu while choosing, Police while guessing) glows with a "choosing" or "investigating" tag.
    - Your own turn gets a spinning role-colour border on the stage, using `@property --spin`.
    - Rows get a stripe in the colour of their role once it is public; this never hints at hidden roles.
    - The secret chit flips over in 3D while held (`.chit-inner`).
  - Phones set to reduced motion get no animations at all, including the count-up.
- **Phone extras:**
  - The secret chit is press-and-hold (pointer events, `touch-action: none`).
  - A wake lock keeps the screen on while in a room.
  - The phone vibrates on your turn, but only after the player has tapped the page once (a Chrome rule).
- **Shuffle screen:** when a round starts (the phase goes from `lobby` or `result` to `choose`), the client shows four face-down chits swapping places for `SHUFFLE_MS` (800 ms; the owner changed it from 500) before the round screen. It is client-only, so a reload mid-round skips it.
- **Investigating screen:** during `guess`, everyone except the Police sees a 🔍 sweeping between the two suspects' names with "👮 X is investigating…". Your own name shows as "You".
- **Bots on screen:** a 🤖 avatar instead of the initial. The lobby's start button reads "Start with N bots 🤖" when seats are empty. The stop button counts only people, e.g. `(1/2)`.
- **Role emoji:** Babu 👑, Police 👮, Dakat 🗡️, Chor 🦹. Don't use 🥷: it shows as an empty box on Windows 10 and older Android.
- **Role colors:** Babu `#f6b93b`, Police `#4f8cff`, Dakat `#ff5c63`, Chor `#a07cff`. Background `#13111c`.

## Running and testing

Needs Node.js 22 or newer; the tests use Node's built-in `WebSocket`. The dev PC runs Windows 10 with Node 24.

- `npm install`: first time, and again after copying the folder, since `node_modules` isn't copied.
- `npm start`, then open `http://localhost:3000`.
  - Phones use `http://<PC's IP>:3000`; `npm start` prints it. On 2026-10-24 the PC was on wired Ethernet at `192.168.1.95`, on the network "EDENGROUP", with its Wi-Fi off. Later the same day the Wi-Fi was on too, at `192.168.1.91`; either address works. The address can change. Phones must be on the same network (a `192.168.1.x` address).
  - Windows marks that network as Public, but Windows Firewall's Public and Private profiles were off on this PC (checked 2026-10-24), so nothing should block phones. If the firewall is turned on, Node.js must be allowed for the network type in use. A router with "client isolation" (common on guest Wi-Fi) would also block phones.
- `.claude/launch.json` lets the Claude desktop app start the server in its browser pane (configuration name `cpdb`).
- `npm test`: run after any change to `game.js` or `server.js`, and update `test/play.js` when rules change.
- **Manual check:** open 4 browser tabs on different addresses (`localhost`, `127.0.0.1`, `[::1]` and the LAN IP). Each address has its own storage, so the tabs act like 4 separate phones.

## Status

As of 2026-10-24.

**Done:**
- The full game as described above.
- `npm test` passes.
- A 4-tab browser playthrough at phone size checked: lobby, roles, peek, wrong-guess scoring, reload rejoin, stop vote, game over and score sheet.
- Bots for games with 1–3 people. `npm test` passes (5 runs in a row), and a browser playthrough of 1 person + 3 bots checked the lobby, bot moves, scoring, game over and play again.
- On GitHub and deployed to Render. A bot script played one full round against the live URL over `wss://`: pages load, scoring is right, and roles stay hidden mid-round.

**Not done or not verified yet:**
- Playing on real phones, over Wi-Fi or the live link.
- Installing on Android from the live link.
- iPhone.

**Next:** the owner plays with friends on real phones using the live link, and installs it on Android.

**Ideas not built:** sounds, Bengali/Hindi text, avatars, chat, a round timer, rooms that survive a server restart.

## Changelog

- **2026-10-24:** First version built and tested. Chor emoji changed from 🥷 to 🦹. Added the keep-awake `/healthz` ping. Project moved to `D:\Avijit\CPDB`; `node_modules` needs `npm install` there.
- **2026-10-24:** Added this CLAUDE.md.
- **2026-10-24:** Reinstalled dependencies in `D:\Avijit\CPDB`; `npm test` passes there. Recreated `.claude/launch.json`. Server started for the first phone test at `http://192.168.1.95:3000`.
- **2026-10-24:** Made the folder a git repository and pushed it to `github.com/Avijit0104/Chor-Police-Dakat-Babu`. Noted that the PC's Wi-Fi is now also on, at `192.168.1.91`.
- **2026-10-24:** Deployed to Render at `https://chor-police-dakat-babu.onrender.com` and checked it with a live bot round. Added the play link to the README.
- **2026-10-24:** Added bots: the host can start with 1–3 people and bots fill the empty seats. Tests and docs updated. Noticed Claude in Chrome on this PC could not open `localhost`/`127.0.0.1` pages (connection refused) but could open the LAN address, e.g. `http://192.168.1.95:3001`.
- **2026-10-24:** Added a small "Created by Avijit Bose" credit at the bottom of every screen, at the owner's request.
- **2026-10-24:** Added a half-second shuffle screen before each round and a "Police is investigating" screen for the other players. Pushed on the owner's request before the browser check of these screens was finished.
- **2026-10-24:** The owner set `SHUFFLE_MS` to 800.
- **2026-10-24:** Rewrote the README for players, with 8 screenshots taken by the new `scripts/screenshots.js`. Removed the server running and hosting sections from it at the owner's request; those details stay in this file. The screenshots also confirmed the shuffle and investigating screens render correctly.
- **2026-10-26:** Redesigned the UI with more styling and animations (see "Animations" under Client details) and the Fredoka font. `scripts/screenshots.js` now waits for entry animations before each shot. Screenshots retaken; `npm test` passes.
