# CPDB: Chor Police Dakat Babu

A 4-player chit game for friends. Everyone plays on their own phone in the browser, and on Android it installs like a normal app.

## Play on the same Wi-Fi (works right now, free)

1. On your PC, open a terminal in this folder and run:

   ```bash
   npm install
   ```

   (first time only), then:

   ```bash
   npm start
   ```

2. It prints an address like `http://192.168.1.91:3000`. Friends on the same Wi-Fi open that address in Chrome on their phones.
3. The first time, Windows may ask whether Node.js can use the network. Tick **Private networks** and click **Allow**, or phones won't be able to connect.
4. One player taps **Create a room**. The others type the 4-letter code and tap **Join**, or use the **Share invite link** button.

The PC has to stay on while you play. You don't need internet for this, only the same Wi-Fi (or the PC's hotspot).

## Play online from anywhere (free)

Host it on Render's free plan:

1. Put this folder in a new GitHub repository.
2. Sign in at [render.com](https://render.com) with GitHub, choose **New → Blueprint** and pick the repository. `render.yaml` already holds the settings (free plan, `npm install`, `npm start`).
3. You get a link like `https://cpdb-xxxx.onrender.com`. Send it to your friends; every group makes its own room.

The catch with the free plan: when nobody has used it for 15 minutes the server goes to sleep, so the first person to open it waits up to a minute. A sleeping server also forgets its rooms, which only matters between games, because a game in progress keeps it awake.

Need a link for just tonight? Run `npm start` and then Cloudflare's free quick tunnel (`cloudflared tunnel --url http://localhost:3000`, no account needed). It gives a public `https://…trycloudflare.com` link that works while your PC is on.

## Install it on Android

Open the online `https://` link in Chrome, then tap **⋮ → Add to Home screen** (or **Install app**), or tap the **Install CPDB on this phone** button on the start screen. It gets its own icon and opens full screen. Installing needs `https`, so it isn't offered on the plain Wi-Fi address.

## Rules

1. 4 players. Every round each player gets a random chit: 👑 Babu 1200, 👮 Police 900, 🗡️ Dakat 600, 🦹 Chor 300.
2. Everyone sees who is Babu and who is Police. Chor and Dakat stay secret: you press and hold your chit to peek at it.
3. The Babu gets 1200 for free and picks who the Police must find: the Chor or the Dakat. Everyone sees the choice ("Babu selected Chor").
4. The Police guesses which of the two hidden players has that chit.
5. Right guess: Police gets 900, the caught player gets 0, the other one keeps their points.
6. Wrong guess: Police gets 0, Chor and Dakat both keep their points.
7. Play as many rounds as you like. When all 4 players have voted to stop, the current round finishes and the highest total wins.

## Good to know

- If a phone locks or someone reloads, the game reconnects them to the same seat.
- Someone switching phones can join the same room code with the same name and gets their seat back.
- In the lobby, the host can remove a player who went offline to free the seat.
- The server never sends other players' Chor or Dakat chits to a phone until the round is over, so nobody can cheat by inspecting the page.

## Project files

| File | What it does |
|---|---|
| `server.js` | Web server and rooms (WebSockets) |
| `game.js` | Game rules and scoring |
| `public/` | The phone app: page, styles, script, icons |
| `test/play.js` | 4 bot players play a scripted game and check the rules (`npm test`) |
| `scripts/make-icons.ps1` | Redraws the app icons |
