# WOD Giveaway Platform — Setup Guide

## 1. Install dependencies

```bash
cd backend
npm install
```

## 2. Configure environment variables

```bash
cp .env.example .env
```

Then fill in `.env`:

- **SESSION_SECRET** — any long random string
- **ADMIN_PASSWORD** — the password you'll use to log into `/admin`
- **Discord OAuth** — create an app at https://discord.com/developers/applications
  - Add a redirect URL matching `DISCORD_CALLBACK_URL`
  - `DISCORD_GUILD_ID` is your server's ID (right-click your server icon in Discord → Copy Server ID; you'll need Developer Mode on in Discord settings)
- **Google OAuth (YouTube)** — create credentials at https://console.cloud.google.com
  - Enable the YouTube Data API v3
  - Add a redirect URL matching `GOOGLE_CALLBACK_URL`

## 3. Run the server

```bash
npm start
```

- Site: http://localhost:3000
- Admin panel: http://localhost:3000/admin

The SQLite database (`backend/db/wod.sqlite`) is created automatically on first run.

## 4. Discord bot (optional but recommended)

The bot handles three things the website can't do on its own:

- **Verified role sync** — automatically gives anyone who's verified Discord membership a "Verified" role, every 5 minutes.
- **Leave detection** — if someone verifies, then leaves your server, their entries get automatically flagged with an admin note instead of silently staying valid.
- **`/draw` and `/pending` commands** — admin-only slash commands. `/draw firm:lucidtrading count:5` randomly draws winners from approved entries, posts an embed announcement, and DMs each winner. `/pending` gives you a quick count of order numbers still waiting on manual review.

### Setup

1. In the same Discord Developer Portal app you made for OAuth, go to the **Bot** tab, click **Add Bot**, and copy the token.
2. Under **Privileged Gateway Intents**, enable **Server Members Intent** — the bot needs this for role sync and leave detection.
3. Invite the bot to your server with the `bot` and `applications.commands` scopes, and give it `Manage Roles` permission (and make sure its role sits above the "Verified" role in your role list).
4. In your server, create a "Verified" role and copy its ID.
5. Copy your own Discord user ID (this becomes your `ADMIN_DISCORD_IDS`).

```bash
cd bot
npm install
cp .env.example .env   # fill in the values above
npm start
```

The bot reads and writes the same `backend/db/wod.sqlite` file the website uses — no extra syncing required, just run both processes.

## 5. Known TODOs before this is production-ready

- **YouTube subscription check** — the Google strategy currently logs the user in but doesn't yet call the YouTube Data API to confirm they're subscribed to your channel. That's a single API call (`subscriptions.list` with `mine=true`, filtered by channel ID) — flagged in `server.js`.
- **Giveaways page** — built (`frontend/giveaways.html` + `giveaway.js` + `giveaway.css`), served at `/giveaways`. Handles login gate, the 5-platform checklist, per-firm order submission, and a live status table pulling from the same API in `script.js`. No indicator page was built — WOD's site is homepage + giveaways only.
- **Discord bot** — built (`bot/bot.js`). Syncs a Verified role, flags entries if someone leaves after verifying, and runs `/draw` + `/pending` admin commands. See section 4 above.
- **Images** — every `assets/*-placeholder.png` reference in `index.html` needs a real image dropped into `frontend/assets/` with a matching filename (or update the `src` paths).
- **Discount percentages / account sizes** — search `index.html` for `[XX]` and `[ACCOUNT SIZE]` placeholders and fill in real numbers.
- **Instagram / TikTok / X verification** — self-reported only (see note in `schema.sql`). Spot-check periodically; there's no public API for automated follow-checks on these platforms as of this build.

## 5. How the manual order verification actually works, day to day

1. User buys an eval with code WOD, submits their order number on your site.
2. It lands in your admin panel at `/admin` as "pending."
3. You log into Lucid/Tradeify/Alpha Futures and check that order number is real and used code WOD.
4. Click Approve or Reject in the admin panel.
5. Approved bonus entries automatically join the draw pool — no extra step needed.

The database enforces that the **same order number can never be submitted twice**, even by different users, so someone can't screenshot a friend's confirmation and reuse it.
