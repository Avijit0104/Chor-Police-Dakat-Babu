# CPDB: project notes for Claude

**Keep this file current.** Whenever you change a rule, a screen, a file, how it is run or hosted, or a decision below, update the matching section in the same change and add a line to the Changelog. A new session should be able to pick up from this file alone. Keep `README.md` (the player-facing guide) in sync too.

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

### Choices made where the rules were silent (the owner can change these)

- **Stop vote:** can be cast or undone at any time during play, and stays until undone. If all 4 vote mid-round, that round finishes first, then the game ends.
- **Next round:** starts when all 4 tap "Next round" on the result screen.
- **Babu's view:** the Babu does not learn who is Chor or Dakat before choosing.
- **Ties:** players share the win. Standings use 1, 2, 3, 3 style ranking.
- **Starting:** the host can start only with 4 connected players. In the lobby, the host can remove a player who is offline.
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
- **Plain HTML/CSS/JS, no framework or build step.** The only dependency is `ws`.
- **Code lives on GitHub:** public repository `https://github.com/Avijit0104/Chor-Police-Dakat-Babu`, branch `main`. Commits use the identity `Avijit0104 <191544536+Avijit0104@users.noreply.github.com>` (GitHub's private email, set in this repo's git config only). Pushing signs in through Git Credential Manager in the browser; the GitHub CLI (`gh`) is not installed.

## Files

| File | Purpose |
|---|---|
| `game.js` | `Room` class: all rules, scoring and per-player views. No networking. |
| `server.js` | Static file server for `public/`, WebSocket server at `/ws`, rooms map, reconnects, heartbeat, idle-room cleanup, `/healthz`. |
| `public/index.html` | Page shell. |
| `public/style.css` | All styles. Dark theme, mobile-first, max width 480px. |
| `public/app.js` | The whole client: connection, rendering, actions, peek, wake lock, install button. |
| `public/manifest.webmanifest`, `public/sw.js` | Make it installable. The service worker is network-first with cache `cpdb-v1`; bump the name if caching changes. |
| `public/icon-*.png` | App icons, generated by `scripts/make-icons.ps1` (Windows `System.Drawing`). |
| `test/play.js` | Starts the server on port 3999 and has 4 bots play 3 rounds. It checks scoring, secrecy of Chor/Dakat, error cases, reconnect, rejoin by name, tab takeover, stop vote, play again and leaving. |
| `render.yaml` | Render blueprint: free plan, `npm install`, `npm start`, health check `/healthz`. |
| `README.md` | Player-facing guide: running, hosting, installing, rules. |

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
- `players[i]`: `{id, name, connected, total, ready, stopVote}`
- `round`: `{number, babuId, policeId, yourRole, target}`, plus `roles`, `guessId`, `correct`, `points` after the round
- `history[i]`: `{number, roles, points}`

### Server details

- Room codes are 4 letters, without I or O.
- Pings every 25s drop dead connections.
- Empty rooms are deleted after 30 minutes in the lobby, or 6 hours otherwise.
- Room limit: 2000. Message size limit: 4 KB.
- `PORT` env variable, default 3000. On start it prints the LAN addresses phones can use.

### Client details (`public/app.js`)

- **Seat storage:** the seat `{code, token}` is saved under the key `cpdb.session`, in `sessionStorage` first (one seat per tab) and `localStorage` second (survives the browser closing). The player's name is saved under `cpdb.name`.
- **Reconnecting:** automatic, with a 1–8s backoff. It resumes the seat on reconnect and reconnects right away when the page becomes visible again.
- **Rendering:** `render()` redraws `#app` from the latest state using template strings. The home screen is drawn once so its text boxes aren't wiped. Clicks are handled through `data-action` attributes.
- **Phone extras:**
  - The secret chit is press-and-hold (pointer events, `touch-action: none`).
  - A wake lock keeps the screen on while in a room.
  - The phone vibrates on your turn, but only after the player has tapped the page once (a Chrome rule).
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
