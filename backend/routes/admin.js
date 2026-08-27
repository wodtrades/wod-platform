const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { parse: parseCsv } = require('csv-parse/sync');
const router = express.Router();
const db = require('../db/db');
const { getWeekKey } = require('../lib/week');
const { postToDiscordChannel } = require('../lib/discord');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Simple shared-password admin auth — fine for a single-operator dashboard.
// Set ADMIN_PASSWORD in .env. Do NOT reuse a password from anywhere else.
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'admin login required' });
}

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'wrong password' });
});

router.post('/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

// List entries waiting on manual verification, newest first.
// Order entries are auto-approved on submission now (see routes/entries.js),
// so this will normally be empty — kept for anything that's ever manually
// reset to 'pending' or added by a future non-instant entry type.
router.get('/entries/pending', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT entries.*, users.discord_username
    FROM entries
    JOIN users ON users.id = entries.user_id
    WHERE entries.entry_type = 'bonus' AND entries.verification_status = 'pending'
    ORDER BY entries.created_at ASC
  `).all();
  res.json({ entries: rows });
});

// Most recent order-code entries (any status), newest first — for spot-checking
// order numbers against the firm dashboard after the fact. Orders are
// auto-approved on submission, so this is a review/fraud-catch list, not a
// verification queue. Reject here to pull a fake/unmatched entry back out
// of the draw pool.
router.get('/entries/recent-orders', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = db.prepare(`
    SELECT entries.*, users.discord_username
    FROM entries
    JOIN users ON users.id = entries.user_id
    WHERE entries.source = 'order'
    ORDER BY entries.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json({ entries: rows });
});

// Approve — you've confirmed the order number + code WOD in your firm dashboard
router.post('/entries/:id/approve', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.prepare(`
    UPDATE entries SET verification_status = 'approved', verified_at = datetime('now')
    WHERE id = ?
  `).run(id);
  db.prepare(`INSERT INTO audit_log (action, details) VALUES ('entry_approved', ?)`)
    .run(JSON.stringify({ entry_id: id }));
  res.json({ ok: true });
});

// Reject — order number didn't match, code wasn't used, etc.
router.post('/entries/:id/reject', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  db.prepare(`
    UPDATE entries SET verification_status = 'rejected', admin_notes = ?, verified_at = datetime('now')
    WHERE id = ?
  `).run(reason || null, id);
  db.prepare(`INSERT INTO audit_log (action, details) VALUES ('entry_rejected', ?)`)
    .run(JSON.stringify({ entry_id: id, reason }));
  res.json({ ok: true });
});

// All entries, any status — useful for a full audit view
router.get('/entries/all', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT entries.*, users.discord_username
    FROM entries
    JOIN users ON users.id = entries.user_id
    ORDER BY entries.created_at DESC
  `).all();
  res.json({ entries: rows });
});

// Pull every approved entry for a given firm — this is your draw pool
router.get('/draw-pool/:firm', requireAdmin, (req, res) => {
  const { firm } = req.params;
  const rows = db.prepare(`
    SELECT entries.*, users.discord_username
    FROM entries
    JOIN users ON users.id = entries.user_id
    WHERE entries.verification_status = 'approved'
      AND (entries.entry_type = 'base' OR entries.prop_firm = ?)
  `).all(firm);
  res.json({ pool: rows });
});

// Per-user entry breakdown for the CURRENT giveaway week (Sat-Fri) —
// this is what you actually draw from every Friday. Only counts
// approved entries (pending order submissions aren't in the pool yet).
router.get('/weekly-summary', requireAdmin, (req, res) => {
  const weekKey = req.query.week || getWeekKey();

  const rows = db.prepare(`
    SELECT
      users.id AS user_id,
      users.discord_username,
      SUM(CASE WHEN entries.entry_type = 'base' THEN 1 ELSE 0 END) AS base_entries,
      SUM(CASE WHEN entries.source = 'order' THEN 1 ELSE 0 END) AS order_entries,
      SUM(CASE WHEN entries.source = 'referral' THEN 1 ELSE 0 END) AS referral_entries,
      COUNT(*) AS total_entries
    FROM entries
    JOIN users ON users.id = entries.user_id
    WHERE entries.week_key = ? AND entries.verification_status = 'approved'
    GROUP BY entries.user_id
    ORDER BY total_entries DESC
  `).all(weekKey);

  const pendingOrders = db.prepare(`
    SELECT entries.*, users.discord_username
    FROM entries
    JOIN users ON users.id = entries.user_id
    WHERE entries.week_key = ? AND entries.source = 'order' AND entries.verification_status = 'pending'
    ORDER BY entries.created_at ASC
  `).all(weekKey);

  res.json({ week_key: weekKey, users: rows, pending_orders: pendingOrders });
});

// =================================================================
// DRAW WINNERS
//
// Run this after Weekly Reconciliation, right before announcing. Two-step
// flow so the admin can re-roll before committing to anything:
//   1. POST /draw — pure random draw, nothing is saved or posted. Call
//      again with the same count to re-roll a different set of winners.
//   2. POST /draw/announce — takes the exact winners array the admin is
//      happy with, saves it to giveaway_draws, and posts the announcement
//      to the Discord winners channel.
// =================================================================

// Each APPROVED entry for the week is one "ticket" — a user with 5
// entries is 5x as likely to be drawn as a user with 1, since they
// literally have 5x as many tickets in the pool. Fisher-Yates shuffle
// (crypto.randomInt, not Math.random — this decides real prize money,
// worth using a proper unbiased RNG) then walk the shuffled tickets,
// taking the first not-yet-picked user per ticket, capped at one win per
// person per draw.
function drawWinners(weekKey, requestedCount) {
  const pool = db.prepare(`
    SELECT entries.id AS entry_id, entries.entry_type, entries.source, entries.prop_firm,
           entries.user_id, users.discord_id, users.discord_username
    FROM entries
    JOIN users ON users.id = entries.user_id
    WHERE entries.week_key = ? AND entries.verification_status = 'approved'
  `).all(weekKey);

  const userEntryCounts = new Map();
  for (const row of pool) {
    userEntryCounts.set(row.user_id, (userEntryCounts.get(row.user_id) || 0) + 1);
  }
  const eligibleUserCount = userEntryCounts.size;
  const count = Math.min(requestedCount, eligibleUserCount);

  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const winners = [];
  const seenUsers = new Set();
  for (const entry of shuffled) {
    if (winners.length >= count) break;
    if (seenUsers.has(entry.user_id)) continue;
    seenUsers.add(entry.user_id);
    winners.push({
      user_id: entry.user_id,
      discord_id: entry.discord_id,
      discord_username: entry.discord_username,
      winning_entry_id: entry.entry_id,
      winning_entry_type: entry.entry_type,
      winning_entry_source: entry.source,
      total_entries_this_week: userEntryCounts.get(entry.user_id)
    });
  }

  return { total_entries: pool.length, eligible_users: eligibleUserCount, winners };
}

router.post('/draw', requireAdmin, (req, res) => {
  const weekKey = (req.body && req.body.week) || getWeekKey();
  const requestedCount = parseInt(req.body && req.body.count, 10);
  if (!requestedCount || requestedCount < 1) {
    return res.status(400).json({ error: 'count must be a positive integer' });
  }

  const { total_entries, eligible_users, winners } = drawWinners(weekKey, requestedCount);
  res.json({ week_key: weekKey, total_entries, eligible_users, requested_count: requestedCount, winners });
});

// Builds the Discord announcement message from a winners array (see
// drawWinners() above for the shape).
function buildWinnersAnnouncement(winners) {
  // # gives a big, bold Discord heading (their markdown, not just **bold**)
  // — used for the main title plus the three sections that should pop the
  // same way. Each winner gets their own line (not space-separated) so a
  // long winner list doesn't run together.
  const mentions = winners.map(w => `<@${w.discord_id}>`).join('\n');
  return [
    `# 🎉 THIS WEEK'S GIVEAWAY WINNERS 🎉`,
    ``,
    `**${winners.length} winner${winners.length === 1 ? '' : 's'} this week!** They each get a **FREE** evaluation.`,
    ``,
    `Your support makes this possible. Thank you for using code **WOD**, and stay tuned for another giveaway next week!`,
    ``,
    `**WINNERS NOTICE:**`,
    ``,
    `I'll contact you directly if you win. I will never ask for passwords, payment, or sensitive personal information. Please be cautious of impersonators and scammers.`,
    ``,
    `After receiving your prize, please share your giveaway proof in #giveaway-proof so people know the accounts are given away.`,
    ``,
    `# WINNERS:`,
    ``,
    mentions,
    ``,
    `# I do Giveaways EVERY WEEK!`,
    ``,
    `# Code WOD`
  ].join('\n');
}

// Commits a previously-previewed winners list (from POST /draw) and posts
// the announcement to Discord. Body: { week?, winners: [...] } — winners
// should be exactly what a /draw call returned, unmodified.
router.post('/draw/announce', requireAdmin, async (req, res) => {
  const { winners } = req.body || {};
  const weekKey = (req.body && req.body.week) || getWeekKey();

  if (!Array.isArray(winners) || winners.length === 0) {
    return res.status(400).json({ error: 'winners must be a non-empty array — run a draw first' });
  }

  const totalEntries = db.prepare(`
    SELECT COUNT(*) AS c FROM entries WHERE week_key = ? AND verification_status = 'approved'
  `).get(weekKey).c;

  db.prepare(`
    INSERT INTO giveaway_draws (draw_date, total_entries_in_draw, winners_json)
    VALUES (?, ?, ?)
  `).run(weekKey, totalEntries, JSON.stringify(winners));

  db.prepare(`INSERT INTO audit_log (action, details) VALUES ('giveaway_winners_drawn', ?)`)
    .run(JSON.stringify({ week_key: weekKey, count: winners.length, winners }));

  let discordPosted = false;
  let discordError = null;
  try {
    if (!process.env.DISCORD_WINNERS_CHANNEL_ID) {
      throw new Error('DISCORD_WINNERS_CHANNEL_ID not set in .env');
    }
    await postToDiscordChannel(process.env.DISCORD_WINNERS_CHANNEL_ID, buildWinnersAnnouncement(winners));
    discordPosted = true;
  } catch (err) {
    discordError = err.message;
    console.error('Failed to post winners announcement to Discord:', err);
  }

  res.json({ ok: true, week_key: weekKey, saved: true, discord_posted: discordPosted, discord_error: discordError });
});

// Most recent draws, newest first — winner history for the admin panel.
router.get('/draws/recent', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM giveaway_draws ORDER BY id DESC LIMIT 10`).all();
  const draws = rows.map(r => ({ ...r, winners: JSON.parse(r.winners_json || '[]') }));
  res.json({ draws });
});

// =================================================================
// WEEKLY RECONCILIATION
//
// Order entries auto-approve instantly on submission (see routes/entries.js)
// for a fast, responsive UX. The real fraud check happens here, once a
// week, right before the Friday draw:
//   1. Admin uploads that week's CSV export from Lucid + Tradeify (and/or
//      manually enters AlphaFutures rows, since it has no export) into
//      verified_order_records — the ground-truth data.
//   2. Admin runs POST /reconcile, which checks every approved order entry
//      for the target week against that ground-truth data. Anything that
//      doesn't match gets flipped to 'rejected' and drops out of the pool
//      — including cascading to any referral bonus that order triggered.
// =================================================================

function normalizeOrderNumber(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^#/, '');
}

// Status values seen on affiliate exports vary a lot, and firms don't
// agree on what they mean (e.g. Lucid's "unpaid" just means the payout
// to the affiliate hasn't been sent yet, NOT that the order isn't real —
// confirmed against a known-good order in testing). Only exclude rows
// whose status clearly indicates the order itself didn't happen or was
// undone. When in doubt, a row is INCLUDED (matching is still gated by
// the order number + date actually appearing in the firm's own export,
// which is the real signal) — adjust this list if a firm confirms a
// different status actually means "not a real order."
const EXCLUDED_STATUS_KEYWORDS = ['rejected', 'declined', 'void', 'voided', 'cancelled', 'canceled', 'refunded', 'chargeback', 'fraud'];

function isExcludedStatus(rawStatus) {
  const s = String(rawStatus || '').trim().toLowerCase();
  if (!s) return false;
  return EXCLUDED_STATUS_KEYWORDS.some(keyword => s.includes(keyword));
}

// Finds a column value on a parsed CSV row by trying several candidate
// header names, case-insensitively, tolerant of extra whitespace — since
// we can't guarantee exact header casing/spacing from every export.
function findColumn(row, candidates) {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const match = keys.find(k => k.trim().toLowerCase() === candidate.toLowerCase());
    if (match) return row[match];
  }
  return undefined;
}

// Parses a date string in whatever format the export uses into an ISO
// YYYY-MM-DD string. Tries common explicit formats first (safer than
// relying on JS's ambiguous native Date parsing for M/D vs D/M), then
// falls back to new Date() as a last resort. Returns null if unparseable.
function parseFlexibleDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  // MM/DD/YYYY or MM-DD-YYYY (US format — assumed, since both partner
  // firms are US-based; flip month/day here if an export turns out to
  // use DD/MM/YYYY instead)
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;

  const fallback = new Date(s);
  if (!isNaN(fallback.getTime())) return fallback.toISOString().slice(0, 10);

  return null;
}

const CSV_FIRM_COLUMNS = {
  lucidtrading: { orderNumber: ['reference'], date: ['date'], status: ['status'] },
  tradeify: { orderNumber: ['order', 'order #', 'order#'], date: ['date'], status: ['status'] }
};

function upsertVerifiedOrder({ propFirm, orderNumber, orderDate, source, statusRaw }) {
  const normalized = normalizeOrderNumber(orderNumber);
  if (!normalized || !orderDate) return { skipped: true };

  const weekKey = getWeekKey(new Date(`${orderDate}T00:00:00Z`));
  const excluded = isExcludedStatus(statusRaw) ? 1 : 0;

  db.prepare(`
    INSERT INTO verified_order_records (prop_firm, order_number, order_number_normalized, order_date, week_key, source, status_raw, excluded, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(prop_firm, order_number_normalized) DO UPDATE SET
      order_number = excluded.order_number,
      order_date = excluded.order_date,
      week_key = excluded.week_key,
      source = excluded.source,
      status_raw = excluded.status_raw,
      excluded = excluded.excluded,
      uploaded_at = datetime('now')
  `).run(propFirm, String(orderNumber).trim(), normalized, orderDate, weekKey, source, statusRaw || null, excluded);

  return { skipped: false, weekKey, excluded: !!excluded };
}

// Upload a CSV export from Lucid or Tradeify. Re-uploading overwrites
// matching rows (by order number), so it's safe to re-upload the same
// or an updated file without creating duplicates.
router.post('/verified-orders/import-csv', requireAdmin, upload.single('file'), (req, res) => {
  const { firm } = req.body;
  if (!CSV_FIRM_COLUMNS[firm]) {
    return res.status(400).json({ error: 'firm must be lucidtrading or tradeify (AlphaFutures has no CSV export — use the manual entry form)' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'no file uploaded' });
  }

  let records;
  try {
    records = parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: `could not parse CSV: ${err.message}` });
  }

  const columns = CSV_FIRM_COLUMNS[firm];
  const source = firm === 'lucidtrading' ? 'csv_lucid' : 'csv_tradeify';

  let imported = 0, excludedCount = 0, unparsed = 0;
  for (const row of records) {
    const orderNumberRaw = findColumn(row, columns.orderNumber);
    const dateRaw = findColumn(row, columns.date);
    const statusRaw = findColumn(row, columns.status);
    const orderDate = parseFlexibleDate(dateRaw);

    if (!orderNumberRaw || !orderDate) {
      unparsed++;
      continue;
    }

    const result = upsertVerifiedOrder({ propFirm: firm, orderNumber: orderNumberRaw, orderDate, source, statusRaw });
    if (!result.skipped) {
      imported++;
      if (result.excluded) excludedCount++;
    }
  }

  db.prepare(`INSERT INTO audit_log (action, details) VALUES ('verified_orders_csv_imported', ?)`)
    .run(JSON.stringify({ firm, total_rows: records.length, imported, excluded: excludedCount, unparsed }));

  res.json({ ok: true, firm, total_rows: records.length, imported, excluded: excludedCount, unparsed });
});

// Manual entry for AlphaFutures (no CSV export available). Body:
// { records: [{ order_number, order_date }, ...] } — order_date as YYYY-MM-DD.
router.post('/verified-orders/manual', requireAdmin, (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records must be a non-empty array of { order_number, order_date }' });
  }

  let imported = 0, unparsed = 0;
  for (const r of records) {
    const orderDate = parseFlexibleDate(r.order_date);
    if (!r.order_number || !orderDate) {
      unparsed++;
      continue;
    }
    upsertVerifiedOrder({ propFirm: 'alphafutures', orderNumber: r.order_number, orderDate, source: 'manual_alphafutures', statusRaw: null });
    imported++;
  }

  db.prepare(`INSERT INTO audit_log (action, details) VALUES ('verified_orders_manual_imported', ?)`)
    .run(JSON.stringify({ firm: 'alphafutures', imported, unparsed }));

  res.json({ ok: true, firm: 'alphafutures', imported, unparsed });
});

// List currently-loaded verified order records, optionally filtered by
// week — lets the admin sanity-check an upload before running reconcile.
router.get('/verified-orders', requireAdmin, (req, res) => {
  const { week, firm } = req.query;
  let query = `SELECT * FROM verified_order_records WHERE 1=1`;
  const params = [];
  if (week) { query += ` AND week_key = ?`; params.push(week); }
  if (firm) { query += ` AND prop_firm = ?`; params.push(firm); }
  query += ` ORDER BY order_date DESC`;
  const rows = db.prepare(query).all(...params);
  res.json({ records: rows });
});

// THE reconciliation pass. Run this after uploading the week's CSVs
// (+ manual AlphaFutures entries), right before drawing winners.
router.post('/reconcile', requireAdmin, (req, res) => {
  const weekKey = (req.body && req.body.week) || getWeekKey();

  const orderEntries = db.prepare(`
    SELECT entries.*, users.discord_username
    FROM entries
    JOIN users ON users.id = entries.user_id
    WHERE entries.source = 'order' AND entries.week_key = ? AND entries.verification_status = 'approved'
  `).all(weekKey);

  const findVerified = db.prepare(`
    SELECT * FROM verified_order_records
    WHERE prop_firm = ? AND order_number_normalized = ? AND week_key = ? AND excluded = 0
  `);
  const findCascadeReferral = db.prepare(`SELECT * FROM referrals WHERE triggering_order_entry_id = ? AND entry_id IS NOT NULL`);
  const rejectEntry = db.prepare(`UPDATE entries SET verification_status = 'rejected', admin_notes = ?, verified_at = datetime('now') WHERE id = ?`);
  const rearmReferral = db.prepare(`UPDATE referrals SET entry_id = NULL, triggering_order_entry_id = NULL WHERE id = ?`);

  const details = [];
  let confirmed = 0, rejected = 0;

  const reconcileTxn = db.transaction(() => {
    for (const entry of orderEntries) {
      const normalized = normalizeOrderNumber(entry.order_number);
      const match = findVerified.get(entry.prop_firm, normalized, weekKey);

      if (match) {
        confirmed++;
        details.push({ entry_id: entry.id, discord_username: entry.discord_username, prop_firm: entry.prop_firm, order_number: entry.order_number, result: 'confirmed' });
        continue;
      }

      rejectEntry.run(`Not found in ${weekKey} affiliate records (reconciliation)`, entry.id);
      db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, 'order_entry_rejected_reconciliation', ?)`)
        .run(entry.user_id, JSON.stringify({ entry_id: entry.id, prop_firm: entry.prop_firm, order_number: entry.order_number, week_key: weekKey }));

      let cascaded = false;
      const cascadeReferral = findCascadeReferral.get(entry.id);
      if (cascadeReferral) {
        rejectEntry.run('Cascade-rejected: triggering order failed weekly reconciliation', cascadeReferral.entry_id);
        rearmReferral.run(cascadeReferral.id); // so a future genuine order from this referee can still earn the bonus
        db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, 'referral_entry_cascade_rejected', ?)`)
          .run(cascadeReferral.referrer_user_id, JSON.stringify({ referral_id: cascadeReferral.id, triggering_entry_id: entry.id }));
        cascaded = true;
      }

      rejected++;
      details.push({ entry_id: entry.id, discord_username: entry.discord_username, prop_firm: entry.prop_firm, order_number: entry.order_number, result: 'rejected', cascade_referral_rejected: cascaded });
    }
  });
  reconcileTxn();

  res.json({ week_key: weekKey, checked: orderEntries.length, confirmed, rejected, details });
});

module.exports = router;
