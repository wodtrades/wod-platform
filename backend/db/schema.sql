-- WOD Giveaway Platform — Database Schema (SQLite)
-- To move to Postgres later: swap AUTOINCREMENT -> SERIAL, TEXT timestamps -> TIMESTAMP,
-- and INTEGER booleans -> BOOLEAN. Structure otherwise carries over directly.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT UNIQUE NOT NULL,
  discord_username TEXT,
  youtube_channel_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Discord + YouTube are automated. Instagram / TikTok / X are self-reported
-- (checked off by the user) since none of those platforms expose a public
-- "does user X follow account Y" API. Spot-check these manually from time to time.
CREATE TABLE IF NOT EXISTS social_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL CHECK (platform IN ('discord','youtube','tiktok','instagram','x')),
  method TEXT NOT NULL CHECK (method IN ('automated','self_reported')),
  is_following INTEGER DEFAULT 0,
  verified_at TEXT,
  UNIQUE(user_id, platform)
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('base','bonus')),
  -- source distinguishes *why* a 'bonus' entry was granted, since 'bonus'
  -- alone doesn't say whether it came from a purchase or a referral.
  -- 'discord_weekly' | 'order' | 'referral' (nullable for old rows).
  source TEXT,
  prop_firm TEXT CHECK (prop_firm IN ('lucidtrading','tradeify','alphafutures')),
  order_number TEXT,
  order_number_hash TEXT,          -- SHA256(prop_firm + order_number), used for duplicate detection
  -- Which giveaway week (Sat-Fri, keyed by that week's Saturday date)
  -- this entry counts toward. See backend/lib/week.js. Nullable for old rows.
  week_key TEXT,
  verification_status TEXT DEFAULT 'pending' CHECK (verification_status IN ('pending','approved','rejected','duplicate_flagged')),
  flagged_as_duplicate INTEGER DEFAULT 0,
  duplicate_of_entry_id INTEGER REFERENCES entries(id),
  admin_notes TEXT,
  verified_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(prop_firm, order_number_hash)   -- hard block: same order number can't be entered twice, ever
);

-- NOTE: indexes on entries(week_key) are created in db.js, AFTER the
-- column-migration step below — not here, because on a database that
-- already has an `entries` table without week_key, CREATE TABLE IF NOT
-- EXISTS is a no-op and an index on a not-yet-existing column would fail.

-- Each user's permanent, never-expiring referral link/code.
CREATE TABLE IF NOT EXISTS referral_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
  referral_id TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Who referred whom. A person can be referred at most once, ever
-- (matches the "each referred person only counts once" rule in the
-- Official Giveaway Rules / referral FAQ).
-- The link is recorded as soon as the referee joins Discord via the
-- referral link (entry_id starts NULL), but the referrer's bonus entry
-- itself isn't granted until the referee's FIRST order entry is approved
-- (see grantReferralBonusIfDue in routes/entries.js) — joining alone no
-- longer earns the referrer anything, only a verified purchase does.
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_user_id INTEGER NOT NULL REFERENCES users(id),
  referee_user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
  week_key TEXT NOT NULL,          -- the week the referee joined
  entry_id INTEGER REFERENCES entries(id),  -- the bonus entry this referral generated (NULL until earned)
  -- The referee's order entry that triggered the bonus, so if that order
  -- later fails weekly reconciliation, the referral bonus cascades to
  -- 'rejected' too instead of surviving on a fake purchase.
  triggering_order_entry_id INTEGER REFERENCES entries(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Ground-truth order data pulled from the prop firms themselves — Lucid/Tradeify
-- CSV exports, or manually-entered rows for AlphaFutures (no export available).
-- This is what weekly reconciliation checks submitted order entries against.
-- Uploaded once a week, right before the Friday draw (see routes/admin.js).
CREATE TABLE IF NOT EXISTS verified_order_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prop_firm TEXT NOT NULL CHECK (prop_firm IN ('lucidtrading','tradeify','alphafutures')),
  order_number TEXT NOT NULL,
  order_number_normalized TEXT NOT NULL,   -- trimmed + lowercased, used for matching
  order_date TEXT,                          -- ISO date (YYYY-MM-DD) from the firm's export
  week_key TEXT,                            -- computed from order_date at import time
  source TEXT,                              -- 'csv_lucid' | 'csv_tradeify' | 'manual_alphafutures'
  status_raw TEXT,                          -- original status column value, kept for audit
  excluded INTEGER DEFAULT 0,               -- 1 if status looked invalid (rejected/void/refunded etc)
  uploaded_at TEXT DEFAULT (datetime('now')),
  UNIQUE(prop_firm, order_number_normalized)
);

CREATE TABLE IF NOT EXISTS giveaway_draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draw_date TEXT,
  total_entries_in_draw INTEGER,
  winners_json TEXT,          -- JSON array of {user_id, entry_id, prop_firm}
  drawn_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
