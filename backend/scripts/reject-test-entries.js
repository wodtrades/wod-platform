// One-off (but safe to re-run) cleanup: pulls dev/test accounts and the
// site's own house account out of a real draw pool. Never hard-deletes —
// marks matching 'approved' entries as 'rejected' with an admin_notes
// explanation, same pattern used elsewhere (weekly reconciliation,
// Discord-leave revocation) so the audit trail/history stays intact.
//
// Targets the CURRENT week by default (i.e. whatever getWeekKey() returns
// right now) since the real concern is "don't let test/house accounts get
// drawn as winners" — pass a week_key as argv[2] to target a different week.
//
// Usage: node scripts/reject-test-entries.js [week_key]
require('dotenv').config();
const db = require('../db/db');
const { getWeekKey } = require('../lib/week');

const weekKey = process.argv[2] || getWeekKey();

// dev_test_user_* = seeded during local/dev testing.
// wodtrades = the site's own house/admin account, not a real participant.
const targets = db.prepare(`
  SELECT entries.id, entries.entry_type, entries.source, users.discord_username
  FROM entries
  JOIN users ON users.id = entries.user_id
  WHERE entries.week_key = ?
    AND entries.verification_status = 'approved'
    AND (users.discord_username LIKE 'dev_test_user%' OR users.discord_username = 'wodtrades')
`).all(weekKey);

if (targets.length === 0) {
  console.log(`No dev/test or house-account entries found in week ${weekKey} — nothing to do.`);
  process.exit(0);
}

console.log(`Week ${weekKey}: found ${targets.length} entries to reject.`);

const reject = db.prepare(`
  UPDATE entries SET verification_status = 'rejected', admin_notes = 'Dev/test or house account — excluded from real draw pool', verified_at = datetime('now')
  WHERE id = ?
`);
const auditLog = db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (NULL, 'test_account_rejected', ?)`);

const runAll = db.transaction((rows) => {
  for (const row of rows) {
    reject.run(row.id);
    auditLog.run(JSON.stringify({ entry_id: row.id, discord_username: row.discord_username, entry_type: row.entry_type, source: row.source, week_key: weekKey }));
  }
});

runAll(targets);

console.log(`Rejected ${targets.length} entries across the following accounts:`);
const byUser = {};
targets.forEach(t => { byUser[t.discord_username] = (byUser[t.discord_username] || 0) + 1; });
Object.entries(byUser).forEach(([user, count]) => console.log(`  ${user}: ${count}`));

process.exit(0);
