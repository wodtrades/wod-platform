const express = require('express');
const passport = require('passport');
const router = express.Router();
const db = require('../db/db');
const { grantWeeklyDiscordEntry, trackReferral } = require('./entries');

// ---------------------------------------------------------------
// DISCORD OAUTH
// Requires: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_CALLBACK_URL,
//           DISCORD_GUILD_ID (your server's ID) in .env
// Passport strategy setup lives in server.js
// ---------------------------------------------------------------

// Deep-links straight into a channel — only works once someone's actually a
// guild member (which every authorized user is, since the OAuth flow below
// auto-joins them). https://discord.com/channels/<guild>/<channel> opens the
// Discord app (or web client) directly on that channel.
function channelUrl(channelId) {
  return `https://discord.com/channels/${process.env.DISCORD_GUILD_ID}/${channelId}`;
}

function howToEnterChannelUrl() {
  return channelUrl(process.env.DISCORD_HOWTOENTER_CHANNEL_ID);
}

// Capture ?ref=<referral_id> (from a /join link) and/or ?to=<channel_id>
// (for CTAs that should land somewhere other than #how-to-enter, e.g. the
// legal page's "open a support ticket" link) before handing off to Discord,
// so both survive the OAuth round-trip in the session.
//
// Every Discord CTA on the site points here. First click for a given
// browser session runs the full OAuth authorize flow (creates the account,
// auto-joins the guild, grants the free entry). Once already logged in,
// there's nothing left to authorize — so instead of re-running OAuth, we
// skip straight to dropping them into the target channel.
router.get('/discord', (req, res, next) => {
  const { ref, to } = req.query;
  if (req.user) {
    return res.redirect(to ? channelUrl(to) : howToEnterChannelUrl());
  }
  if (ref) req.session.referral_id = ref;
  if (to) req.session.discord_redirect_channel = to;
  passport.authenticate('discord')(req, res, next);
});

router.get(
  '/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/?auth=failed' }),
  async (req, res) => {
    // req.user is populated by the Discord strategy in server.js —
    // it already checked guild membership (see verifyClient callback there).
    if (req.session.referral_id && req.user) {
      trackReferral(req.session.referral_id, req.user.id);
      delete req.session.referral_id;
    }
    // Grant this week's free entry immediately on login rather than
    // waiting for the user to load the giveaways page.
    if (req.user) grantWeeklyDiscordEntry(req.user.id);

    const targetChannel = req.session.discord_redirect_channel;
    if (targetChannel) delete req.session.discord_redirect_channel;

    // Straight into the Discord, on the requested channel (or
    // #how-to-enter by default), instead of bouncing back to the homepage.
    res.redirect(targetChannel ? channelUrl(targetChannel) : howToEnterChannelUrl());
  }
);

// ---------------------------------------------------------------
// YOUTUBE (GOOGLE) OAUTH
// Requires: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL,
//           YOUTUBE_CHANNEL_ID (your channel's ID) in .env
// ---------------------------------------------------------------
router.get('/youtube', passport.authenticate('google', {
  scope: ['https://www.googleapis.com/auth/youtube.readonly']
}));

router.get(
  '/youtube/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
  async (req, res) => {
    res.redirect('/?auth=success');
  }
);

router.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ---------------------------------------------------------------
// DEV LOGIN — only active when DEV_MODE=true in .env.
// Logs you in as a fake test user so you can click through the full
// flow (checklist, order submission, admin approval) before real
// Discord/Google API keys are set up. Remove or disable before going live.
// ---------------------------------------------------------------
router.get('/dev-login', (req, res) => {
  if (process.env.DEV_MODE !== 'true') {
    return res.status(403).send('Dev login is disabled. Set DEV_MODE=true in .env to use it.');
  }
  const db = require('../db/db');
  // Support ?ref=<code> and a distinct ?as=<id> so you can log in as
  // multiple fake accounts to test the referral loop end-to-end
  // (e.g. /auth/dev-login as user A, grab their link, then
  // /auth/dev-login?as=2&ref=<A's code> to simulate a referred friend).
  const fakeDiscordId = `dev-${(req.query.as || '000001').toString().padStart(6, '0')}`;

  let user = db.prepare(`SELECT * FROM users WHERE discord_id = ?`).get(fakeDiscordId);
  if (!user) {
    const info = db.prepare(`
      INSERT INTO users (discord_id, discord_username) VALUES (?, ?)
    `).run(fakeDiscordId, `dev_test_user_${fakeDiscordId.replace('dev-', '')}`);
    user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
  }

  // Simulate Discord as verified, same as real OAuth auto-join would confirm.
  // Instagram/TikTok/X/YouTube are all self-reported now (see entries.js),
  // so they deliberately start unverified here too — use the checklist
  // buttons on /giveaways to test those, same as a real user would.
  db.prepare(`
    INSERT INTO social_verifications (user_id, platform, method, is_following, verified_at)
    VALUES (?, 'discord', 'automated', 1, datetime('now'))
    ON CONFLICT(user_id, platform) DO UPDATE SET is_following = 1, verified_at = datetime('now')
  `).run(user.id);

  if (req.query.ref) {
    trackReferral(req.query.ref, user.id);
  }
  grantWeeklyDiscordEntry(user.id);

  req.login(user, (err) => {
    if (err) return res.status(500).send('Dev login failed.');
    res.redirect('/giveaways');
  });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not logged in' });
  res.json({ user: req.user });
});

module.exports = router;
