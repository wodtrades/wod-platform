const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db/db');
const { getWeekKey } = require('../lib/week');

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function siteUrl(req) {
  return process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
}

// ---------------------------------------------------------------
// SELF-REPORT: Instagram / TikTok / X / YouTube
// (Discord is verified automatically at OAuth time — see auth.js. YouTube
// was originally meant to be verified the same way via the YouTube Data
// API, but that requires API access we don't have set up, so it's
// self-reported like the others for now.)
// Following socials is no longer required to unlock the free weekly
// entry (that's Discord-only now, see grantWeeklyDiscordEntry below) —
// this just records the self-report for engagement/audit purposes.
// ---------------------------------------------------------------
router.post('/social/self-report', requireLogin, (req, res) => {
  const { platform } = req.body;
  const allowed = ['instagram', 'tiktok', 'x', 'youtube'];
  if (!allowed.includes(platform)) {
    return res.status(400).json({ error: 'invalid platform' });
  }

  db.prepare(`
    INSERT INTO social_verifications (user_id, platform, method, is_following, verified_at)
    VALUES (?, ?, 'self_reported', 1, datetime('now'))
    ON CONFLICT(user_id, platform) DO UPDATE SET is_following = 1, verified_at = datetime('now')
  `).run(req.user.id, platform);

  res.json({ ok: true });
});

// ---------------------------------------------------------------
// FREE WEEKLY ENTRY: everyone verified in Discord gets 1 entry per
// giveaway week, automatically. Idempotent — safe to call repeatedly.
// Called on login, on every /me and /dashboard check, and from a
// background sweep in server.js so it applies even if a member never
// visits the site that week.
// ---------------------------------------------------------------
function grantWeeklyDiscordEntry(userId) {
  const hasDiscord = db.prepare(
    `SELECT 1 FROM social_verifications WHERE user_id = ? AND platform = 'discord' AND is_following = 1`
  ).get(userId);
  if (!hasDiscord) return false;

  const weekKey = getWeekKey();
  const existing = db.prepare(
    `SELECT id FROM entries WHERE user_id = ? AND entry_type = 'base' AND week_key = ?`
  ).get(userId, weekKey);
  if (existing) return false;

  db.prepare(`
    INSERT INTO entries (user_id, entry_type, source, week_key, verification_status, verified_at)
    VALUES (?, 'base', 'discord_weekly', ?, 'approved', datetime('now'))
  `).run(userId, weekKey);

  db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, 'weekly_base_entry_awarded', ?)`)
    .run(userId, JSON.stringify({ week_key: weekKey }));
  return true;
}

// ---------------------------------------------------------------
// REVOKE ON LEAVE: called from discord-bot.js's guildMemberRemove
// listener whenever anyone leaves the Discord server. Un-verifies them
// for Discord (so grantWeeklyDiscordEntry stops granting future weeks
// until they rejoin) and pulls back the CURRENT week's free base entry
// if they already had one — marked 'rejected', the same status admin
// uses to disqualify an entry, so it drops out of the draw pool
// immediately. Nothing is hard-deleted, matching the rest of the schema
// (see lib/week.js) — the row stays for the audit trail.
// ---------------------------------------------------------------
function revokeDiscordEntry(userId) {
  db.prepare(`
    UPDATE social_verifications SET is_following = 0
    WHERE user_id = ? AND platform = 'discord'
  `).run(userId);

  const weekKey = getWeekKey();
  const result = db.prepare(`
    UPDATE entries SET verification_status = 'rejected', admin_notes = 'Left Discord server', verified_at = datetime('now')
    WHERE user_id = ? AND entry_type = 'base' AND source = 'discord_weekly' AND week_key = ? AND verification_status = 'approved'
  `).run(userId, weekKey);

  if (result.changes > 0) {
    db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, 'weekly_base_entry_revoked', ?)`)
      .run(userId, JSON.stringify({ week_key: weekKey, reason: 'left_discord' }));
  }
  return result.changes > 0;
}

// ---------------------------------------------------------------
// BONUS ENTRY: order number submission (auto-approved on submit)
// One entry per verified order number. No cap on how many qualifying
// orders a user can submit per firm — each real account purchased with
// code WOD this week earns its own entry. The same real order number
// can never be reused (globally unique), so this can't be gamed by
// resubmitting one purchase across multiple weeks.
//
// Entries are approved INSTANTLY on submission for a responsive UX —
// there's no allowlist check and no per-submission gate. The real fraud
// check is a once-a-week RECONCILIATION pass (see POST /api/admin/reconcile)
// run right before the Friday draw: the admin uploads that week's Lucid/
// Tradeify CSVs (+ manual AlphaFutures entries) into verified_order_records,
// and any order entry that doesn't match a real record gets flipped back
// to 'rejected' — pulling it (and any referral bonus it triggered) out of
// the draw pool. See routes/admin.js for that logic.
//
// submitOrderEntry() is the single shared implementation used by BOTH the
// website route below and the Discord bot (discord-bot.js), so there's
// only one copy of this SQL to keep correct — this is deliberate, since a
// second hand-copied version of this insert is exactly what caused the
// SQL-quoting bugs the bot had earlier.
// ---------------------------------------------------------------
const ALLOWED_FIRMS = ['lucidtrading', 'tradeify', 'alphafutures'];

class OrderEntryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function submitOrderEntry(userId, propFirm, orderNumber) {
  if (!ALLOWED_FIRMS.includes(propFirm)) {
    throw new OrderEntryError(400, 'invalid prop firm');
  }
  if (!orderNumber || orderNumber.trim().length < 3) {
    throw new OrderEntryError(400, 'order number looks invalid');
  }

  const cleanOrderNumber = orderNumber.trim();
  const hash = crypto
    .createHash('sha256')
    .update(propFirm + ':' + cleanOrderNumber.toLowerCase())
    .digest('hex');

  // Duplicate check — has this exact order number (for this firm) been used before?
  const duplicate = db.prepare(
    `SELECT id, user_id FROM entries WHERE prop_firm = ? AND order_number_hash = ?`
  ).get(propFirm, hash);

  if (duplicate) {
    db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, 'duplicate_order_attempt', ?)`)
      .run(userId, JSON.stringify({ prop_firm: propFirm, order_number: cleanOrderNumber }));
    throw new OrderEntryError(409, 'This order number has already been submitted. If this is a mistake, contact an admin.');
  }

  const weekKey = getWeekKey();

  const info = db.prepare(`
    INSERT INTO entries (user_id, entry_type, source, prop_firm, order_number, order_number_hash, week_key, verification_status, verified_at)
    VALUES (?, 'bonus', 'order', ?, ?, ?, ?, 'approved', datetime('now'))
  `).run(userId, propFirm, cleanOrderNumber, hash, weekKey);

  const entryId = info.lastInsertRowid;

  db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, 'order_entry_auto_approved', ?)`)
    .run(userId, JSON.stringify({ prop_firm: propFirm, order_number: cleanOrderNumber, week_key: weekKey }));

  // If this user was referred by someone and hasn't yet triggered their
  // referrer's bonus, this verified purchase is what earns it.
  grantReferralBonusIfDue(userId, entryId);

  return { ok: true, entry_id: entryId, status: 'approved', week_key: weekKey };
}

router.post('/order', requireLogin, (req, res) => {
  const { prop_firm, order_number } = req.body;
  try {
    const result = submitOrderEntry(req.user.id, prop_firm, order_number);
    res.json(result);
  } catch (err) {
    if (err instanceof OrderEntryError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
});

// ---------------------------------------------------------------
// REFERRALS
//
// Two-phase now, not one:
//   1. LINK (trackReferral, below) — recorded the moment the referee joins
//      Discord via the referral link. No entry is granted yet. This just
//      remembers "user A referred user B."
//   2. EARN (grantReferralBonusIfDue, below) — fires the first time the
//      referee's own order entry is approved (see submitOrderEntry above).
//      That's when the referrer actually gets their bonus entry, and it's
//      tied to that specific order entry so it can be cascade-rejected if
//      the order later fails weekly reconciliation (see routes/admin.js).
//
// This means joining Discord through a referral link, by itself, no
// longer earns the referrer anything — only a friend's verified purchase
// does. (The referee still gets their own free weekly Discord entry
// either way, same as any member.)
// ---------------------------------------------------------------

// Get-or-create this user's permanent referral link.
router.post('/referral/generate-link', requireLogin, (req, res) => {
  let row = db.prepare(`SELECT referral_id FROM referral_codes WHERE user_id = ?`).get(req.user.id);
  if (!row) {
    const referralId = `${req.user.id}_${crypto.randomBytes(5).toString('hex')}`;
    db.prepare(`INSERT INTO referral_codes (user_id, referral_id) VALUES (?, ?)`).run(req.user.id, referralId);
    row = { referral_id: referralId };
  }
  res.json({ referral_id: row.referral_id, link: `${siteUrl(req)}/join?ref=${row.referral_id}` });
});

// Record a referral LINK ONLY — no entry granted here. Not auth-gated —
// called internally from the Discord OAuth callback in auth.js right
// after a new/returning user logs in with a ?ref= code in their session.
// Exported so auth.js can call it directly (no HTTP round-trip needed).
function trackReferral(referralId, refereeUserId) {
  if (!referralId || !refereeUserId) return { ok: false, reason: 'missing params' };

  const code = db.prepare(`SELECT user_id FROM referral_codes WHERE referral_id = ?`).get(referralId);
  if (!code) return { ok: false, reason: 'unknown referral code' };

  const referrerUserId = code.user_id;
  if (referrerUserId === refereeUserId) {
    return { ok: false, reason: 'self-referral blocked' };
  }

  // Already referred (by this person or anyone else) — referee_user_id is
  // UNIQUE, so silently no-op rather than erroring the login flow.
  const alreadyReferred = db.prepare(`SELECT id FROM referrals WHERE referee_user_id = ?`).get(refereeUserId);
  if (alreadyReferred) return { ok: false, reason: 'already referred' };

  const weekKey = getWeekKey();

  db.prepare(`
    INSERT INTO referrals (referrer_user_id, referee_user_id, week_key, entry_id, triggering_order_entry_id)
    VALUES (?, ?, ?, NULL, NULL)
  `).run(referrerUserId, refereeUserId, weekKey);

  db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, 'referral_linked', ?)`)
    .run(referrerUserId, JSON.stringify({ referee_user_id: refereeUserId, week_key: weekKey }));

  return { ok: true, referrer_user_id: referrerUserId, week_key: weekKey, entry_granted: false };
}

// EARN — called from submitOrderEntry() the moment a referee's order
// entry is approved. Only fires once per referral, ever (guarded by
// entry_id IS NULL — once set, this referral is "spent"). If the
// referee was never referred, or their referrer's bonus was already
// granted, this is a silent no-op.
function grantReferralBonusIfDue(refereeUserId, triggeringOrderEntryId) {
  const referral = db.prepare(
    `SELECT * FROM referrals WHERE referee_user_id = ? AND entry_id IS NULL`
  ).get(refereeUserId);
  if (!referral) return false;

  const weekKey = getWeekKey();

  const entryInfo = db.prepare(`
    INSERT INTO entries (user_id, entry_type, source, week_key, verification_status, verified_at)
    VALUES (?, 'bonus', 'referral', ?, 'approved', datetime('now'))
  `).run(referral.referrer_user_id, weekKey);

  db.prepare(`
    UPDATE referrals SET entry_id = ?, triggering_order_entry_id = ? WHERE id = ?
  `).run(entryInfo.lastInsertRowid, triggeringOrderEntryId, referral.id);

  db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, 'referral_entry_awarded', ?)`)
    .run(referral.referrer_user_id, JSON.stringify({
      referee_user_id: refereeUserId,
      triggering_order_entry_id: triggeringOrderEntryId,
      week_key: weekKey
    }));

  return true;
}

router.post('/referral/track', (req, res) => {
  const { referral_id, referee_user_id } = req.body;
  const result = trackReferral(referral_id, referee_user_id);
  res.json(result);
});

// This week's entry breakdown + referral link, for the logged-in user.
router.get('/dashboard', requireLogin, (req, res) => {
  grantWeeklyDiscordEntry(req.user.id);

  const weekKey = getWeekKey();

  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN entry_type = 'base' THEN 1 ELSE 0 END) AS base_entries,
      SUM(CASE WHEN source = 'order' AND verification_status = 'approved' THEN 1 ELSE 0 END) AS order_entries,
      SUM(CASE WHEN source = 'order' AND verification_status = 'pending' THEN 1 ELSE 0 END) AS order_entries_pending,
      SUM(CASE WHEN source = 'referral' THEN 1 ELSE 0 END) AS referral_entries
    FROM entries
    WHERE user_id = ? AND week_key = ?
      AND verification_status IN ('approved', 'pending')
  `).get(req.user.id, weekKey);

  const base = row.base_entries || 0;
  const orders = row.order_entries || 0;
  const referrals = row.referral_entries || 0;

  let link = db.prepare(`SELECT referral_id FROM referral_codes WHERE user_id = ?`).get(req.user.id);
  if (!link) {
    const referralId = `${req.user.id}_${crypto.randomBytes(5).toString('hex')}`;
    db.prepare(`INSERT INTO referral_codes (user_id, referral_id) VALUES (?, ?)`).run(req.user.id, referralId);
    link = { referral_id: referralId };
  }

  res.json({
    week_key: weekKey,
    summary: {
      base_entries: base,
      order_entries: orders,
      order_entries_pending: row.order_entries_pending || 0,
      referral_entries: referrals,
      total_entries: base + orders + referrals
    },
    referral_link: `${siteUrl(req)}/join?ref=${link.referral_id}`
  });
});

// Public leaderboard — this week's approved entries only, top 10.
router.get('/leaderboard', (req, res) => {
  const weekKey = getWeekKey();
  const rows = db.prepare(`
    SELECT users.discord_username, COUNT(*) AS total_entries
    FROM entries
    JOIN users ON users.id = entries.user_id
    WHERE entries.week_key = ? AND entries.verification_status = 'approved'
    GROUP BY entries.user_id
    ORDER BY total_entries DESC
    LIMIT 10
  `).all(weekKey);
  res.json({ week_key: weekKey, leaderboard: rows });
});

// ---------------------------------------------------------------
// STATUS: user's own entries + social checklist
// ---------------------------------------------------------------
router.get('/me', requireLogin, (req, res) => {
  grantWeeklyDiscordEntry(req.user.id);
  const entries = db.prepare(`SELECT * FROM entries WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id);
  const socials = db.prepare(`SELECT * FROM social_verifications WHERE user_id = ?`).all(req.user.id);
  res.json({ entries, socials, current_week_key: getWeekKey() });
});

module.exports = router;
module.exports.grantWeeklyDiscordEntry = grantWeeklyDiscordEntry;
module.exports.revokeDiscordEntry = revokeDiscordEntry;
module.exports.trackReferral = trackReferral;
module.exports.grantReferralBonusIfDue = grantReferralBonusIfDue;
module.exports.submitOrderEntry = submitOrderEntry;
module.exports.OrderEntryError = OrderEntryError;
