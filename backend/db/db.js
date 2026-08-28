const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// DB_PATH lets production point the sqlite file at a mounted persistent
// volume (e.g. /app/data/wod.sqlite) that lives OUTSIDE the backend/db
// code folder — mounting a volume directly on top of backend/db hides
// db.js/schema.sql themselves (they get shadowed by the empty volume),
// which crashes the app with MODULE_NOT_FOUND. Falls back to the local
// file next to this script for dev, same as before.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'wod.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// --- Loud, unmissable startup diagnostics -----------------------------
// The Aug 2026 incident (real order entries silently wiped) happened
// because a misconfiguration (git-tracked db file / wrong mount path)
// gave zero signal at boot time. From now on, every startup prints
// exactly which file is being opened, whether it's on the persistent
// volume or the ephemeral local fallback, and how much data is already
// in it — so a bad deploy is obvious in the Railway logs immediately,
// not discovered days later when a user's entries have vanished.
console.log('\n=== DATABASE STARTUP ===');
console.log(`DB_PATH env var: ${process.env.DB_PATH ? process.env.DB_PATH : '(not set)'}`);
console.log(`Resolved database file: ${dbPath}`);
if (!process.env.DB_PATH) {
  console.warn('⚠️  DB_PATH is NOT set — using the local fallback file next to db.js.');
  console.warn('⚠️  On Railway this path is EPHEMERAL and will be WIPED on every redeploy.');
  console.warn('⚠️  Production must have DB_PATH pointing at a mounted persistent volume.');
}
const dbExistedBefore = fs.existsSync(dbPath);
const db = new Database(dbPath);

// Run schema on startup (safe to re-run — uses IF NOT EXISTS)
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// --- Lightweight migrations for columns added after the table already
// existed on disk. CREATE TABLE IF NOT EXISTS above won't add columns to
// a table that's already there, so handle those additively here.
// Safe to run on every startup — checks PRAGMA table_info first. ---
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some(c => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[migrate] added ${table}.${column}`);
  }
}

ensureColumn('entries', 'week_key', 'week_key TEXT');
ensureColumn('entries', 'source', 'source TEXT');
ensureColumn('referrals', 'triggering_order_entry_id', 'triggering_order_entry_id INTEGER REFERENCES entries(id)');

// Safe to create after the columns above are guaranteed to exist.
db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_week ON entries(week_key)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_user_week ON entries(user_id, week_key)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_verified_orders_firm_number ON verified_order_records(prop_firm, order_number_normalized)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_verified_orders_week ON verified_order_records(week_key)`);

// --- Report what's actually in the database right now -----------------
// If this ever prints near-zero counts on a redeploy where real users
// already exist, that's the loud red flag that something reset the data
// — visible in the Railway deploy log within seconds, instead of only
// being noticed when a user complains their entries disappeared.
try {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const entryCount = db.prepare('SELECT COUNT(*) as c FROM entries').get().c;
  const bonusCount = db.prepare(`SELECT COUNT(*) as c FROM entries WHERE entry_type = 'bonus'`).get().c;
  console.log(`Database file ${dbExistedBefore ? 'already existed' : 'is NEW (did not exist before this boot)'}`);
  console.log(`Users: ${userCount} | Entries: ${entryCount} (bonus/order entries: ${bonusCount})`);
  if (dbExistedBefore === false && (userCount > 0 || entryCount > 0)) {
    // Shouldn't be reachable (a brand-new file can't already have rows),
    // but kept as a canary in case sqlite/file semantics ever surprise us.
    console.warn('⚠️  Unexpected: new database file but non-zero rows.');
  }
} catch (err) {
  console.error('⚠️  Could not read row counts on startup:', err.message);
}
console.log('=== END DATABASE STARTUP ===\n');

module.exports = db;
