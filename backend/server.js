require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const path = require('path');

const DiscordStrategy = require('passport-discord').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const db = require('./db/db');
const authRoutes = require('./routes/auth');
const entryRoutes = require('./routes/entries');
const adminRoutes = require('./routes/admin');
const discordRoutes = require('./routes/discord');
const { grantWeeklyDiscordEntry } = require('./routes/entries');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-env',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));
app.use(passport.initialize());
app.use(passport.session());

// --- Passport user (de)serialization — pulls from our local users table ---
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  done(null, user);
});

// --- Discord strategy ---
// Verifies the user is actually in your server (guild) at login time.
// Only registered if keys are present, so the server can run without them.
const discordConfigured = !!process.env.DISCORD_CLIENT_ID;
if (discordConfigured) {
  passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    // guilds.join lets us auto-add the user to our server using our bot
    // token + their access token, so "log in with Discord" doubles as a
    // one-click "join the Discord" — no separate invite-link click needed.
    scope: ['identify', 'guilds', 'guilds.join']
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      let inGuild = profile.guilds?.some(g => g.id === process.env.DISCORD_GUILD_ID);

      let user = db.prepare(`SELECT * FROM users WHERE discord_id = ?`).get(profile.id);
      if (!user) {
        const info = db.prepare(`
          INSERT INTO users (discord_id, discord_username) VALUES (?, ?)
        `).run(profile.id, `${profile.username}`);
        user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
      }

      // Not already a member? Add them automatically via the Discord API
      // using our bot token + their OAuth access token (guilds.join scope).
      if (!inGuild && process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID) {
        try {
          const joinRes = await fetch(
            `https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${profile.id}`,
            {
              method: 'PUT',
              headers: {
                Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ access_token: accessToken })
            }
          );
          // 201 = newly added to the guild, 204 = already a member — both are success
          if (joinRes.ok || joinRes.status === 204) {
            inGuild = true;
          } else {
            console.error('Auto-join to Discord guild failed:', joinRes.status, await joinRes.text());
          }
        } catch (err) {
          console.error('Auto-join to Discord guild errored:', err.message);
        }
      }

      if (inGuild) {
        db.prepare(`
          INSERT INTO social_verifications (user_id, platform, method, is_following, verified_at)
          VALUES (?, 'discord', 'automated', 1, datetime('now'))
          ON CONFLICT(user_id, platform) DO UPDATE SET is_following = 1, verified_at = datetime('now')
        `).run(user.id);
      }

      done(null, user);
    } catch (err) {
      done(err);
    }
  }));
} else {
  console.log('Discord OAuth not configured — skipping (dev login available instead).');
}

// --- Google (YouTube) strategy ---
// Checks the user's subscriptions for your channel ID.
// Only registered if keys are present, so the server can run without them.
const googleConfigured = !!process.env.GOOGLE_CLIENT_ID;
if (googleConfigured) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      // NOTE: requires the user to already exist (created via Discord login first).
      // This app expects Discord login as the primary account; YouTube just adds
      // a verification on top of it. If no session user exists, bail gracefully.
      // (Full subscription-check API call is a TODO — see docs/SETUP.md.)
      done(null, profile);
    } catch (err) {
      done(err);
    }
  }));
} else {
  console.log('Google OAuth not configured — skipping (YouTube check will be unavailable until added).');
}

app.use('/auth', authRoutes);
app.use('/api/entries', entryRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/discord', discordRoutes);

// Serve the frontend + admin panel as static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Clean URLs for static pages
app.get('/giveaways', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'giveaways.html'));
});

app.get('/prop-firms', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'prop-firms.html'));
});

app.get('/referral', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'referral.html'));
});

app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'leaderboard.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'terms.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'privacy.html'));
});

app.get('/giveaway-rules', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'giveaway-rules.html'));
});

app.get('/legal', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'legal.html'));
});

// Referral links point here: /join?ref=<code> -> Discord OAuth, with the
// ref code carried through the login flow (see routes/auth.js).
app.get('/join', (req, res) => {
  const { ref } = req.query;
  res.redirect(ref ? `/auth/discord?ref=${encodeURIComponent(ref)}` : '/auth/discord');
});

// --- Weekly free-entry sweep ---
// Everyone verified in Discord is supposed to get 1 free entry every
// giveaway week automatically, not just when they happen to visit the
// site. grantWeeklyDiscordEntry() is a no-op if a user already has this
// week's entry, so re-running this often is cheap and safe. It also
// double-covers anyone the lazy per-request grant (in /api/entries/me
// and /dashboard) hasn't caught yet.
function sweepWeeklyBaseEntries() {
  const discordVerifiedUserIds = db.prepare(`
    SELECT DISTINCT user_id FROM social_verifications WHERE platform = 'discord' AND is_following = 1
  `).all();
  let granted = 0;
  for (const { user_id } of discordVerifiedUserIds) {
    if (grantWeeklyDiscordEntry(user_id)) granted++;
  }
  if (granted > 0) {
    console.log(`[weekly-sweep] granted ${granted} free entr${granted === 1 ? 'y' : 'ies'} for the current week`);
  }
}

app.listen(PORT, () => {
  console.log(`WOD server running on http://localhost:${PORT}`);
  console.log(`Admin panel at http://localhost:${PORT}/admin`);

  sweepWeeklyBaseEntries();
  // Every 6 hours is frequent enough that a new week's entry lands
  // within hours of the Saturday rollover, without needing a real cron.
  setInterval(sweepWeeklyBaseEntries, 1000 * 60 * 60 * 6);
});
