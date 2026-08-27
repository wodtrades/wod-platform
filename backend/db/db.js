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

module.exports = db;
