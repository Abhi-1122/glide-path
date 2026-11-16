# Glide Path

A two-seat co-op dice-placement landing game for the browser. Pilot and Co-pilot each roll dice in secret, place them in silence on a shared control panel, and try to touch down safely after seven rounds.

- Peer-to-peer over WebRTC ([Trystero](https://github.com/dmotz/trystero)), no game server. The host's browser runs the rules.
- Share the room link or 4-letter code with your co-pilot.
- Optional **Tutorial** toggle (off by default, per player) adds a flight-instructor panel, inline tips and live predictions for the selected die.
- Reloading is safe: the host's game is saved locally and resumes; the guest rejoins automatically.

## Develop

```sh
npm install
npm run dev
npm test   # rules engine checks
```

Deploys as a static Vite site (Vercel).
