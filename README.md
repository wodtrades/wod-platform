# WOD Giveaway Platform

A giveaway site for WOD's prop firm sponsorships (Lucid Trading, Tradeify, Alpha Futures).

## How it works

- **Free entry** — join the Discord + follow on TikTok, Instagram, X, and YouTube.
  Discord and YouTube are verified automatically. Instagram/TikTok/X are self-reported
  (no public API exists to verify follows on those platforms).
- **Bonus entries** — buy an eval using code **WOD** at any partner firm, submit the
  order number on the site, and get an extra entry once you manually confirm it against
  your firm dashboard. One bonus entry per firm, max 3 total.
- **Anti-cheat** — every order number is hashed and checked against every other entry
  in the database. The same order number can never be used twice, by anyone.

## Project structure

```
WODS_SEVER/
├── frontend/          → the public-facing site (mirrors Timmy's Dungeon's layout/CTAs)
│   ├── index.html
│   ├── styles.css
│   ├── script.js
│   └── assets/         → drop your real images here (see docs/SETUP.md)
├── backend/            → Node/Express server
│   ├── server.js
│   ├── routes/         → auth.js, entries.js, admin.js
│   ├── db/              → schema.sql + SQLite database
│   └── admin/           → your entry-verification dashboard
├── bot/                → Discord bot (role sync, leave detection, /draw command)
│   └── bot.js
└── docs/
    └── SETUP.md         → full setup instructions — start here
```

## Quick start

See `docs/SETUP.md` for the full walkthrough. Short version:

```bash
cd backend
npm install
cp .env.example .env   # then fill in your keys
npm start
```

Site runs at `http://localhost:3000`, admin panel at `http://localhost:3000/admin`.
