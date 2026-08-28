// Quick diagnostic to check current database state
require('dotenv').config();
const db = require('../db/db');

console.log('\n=== DATABASE DIAGNOSTIC ===\n');

const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
console.log(`Total users: ${userCount.count}`);

const totalEntries = db.prepare('SELECT COUNT(*) as count FROM entries').get();
console.log(`Total entries: ${totalEntries.count}`);

const baseEntries = db.prepare("SELECT COUNT(*) as count FROM entries WHERE entry_type = 'base'").get();
console.log(`Base (weekly free) entries: ${baseEntries.count}`);

const bonusEntries = db.prepare("SELECT COUNT(*) as count FROM entries WHERE entry_type = 'bonus'").get();
console.log(`Bonus (order) entries: ${bonusEntries.count}`);

const currentWeek = db.prepare("SELECT COUNT(*) as count FROM entries WHERE week_key = ?").get(require('../lib/week').getWeekKey());
console.log(`Entries this week (week_key=${require('../lib/week').getWeekKey()}): ${currentWeek.count}`);

console.log('\n=== TOP 5 USERS BY ENTRY COUNT ===\n');
const top5 = db.prepare(`
  SELECT u.discord_username, COUNT(e.id) as entry_count
  FROM users u
  LEFT JOIN entries e ON u.id = e.user_id
  GROUP BY u.id
  ORDER BY entry_count DESC
  LIMIT 5
`).all();

top5.forEach(row => {
  console.log(`${row.discord_username}: ${row.entry_count} entries`);
});

console.log('\n');
process.exit(0);
