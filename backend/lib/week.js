// Giveaway week boundaries.
//
// A giveaway "week" runs Saturday 00:00 UTC through the following Friday
// 23:59:59 UTC. Winners are drawn every Friday (see giveaway.js countdown
// on the frontend), so Friday itself is treated as the lock/draw day:
// anything logged on a Friday is attributed to the NEXT week's pool
// (the week that just closed is already being drawn), not rejected.
//
// week_key is the ISO date (YYYY-MM-DD) of that week's Saturday, and is
// what every weekly-scoped row (base entries, order entries, referral
// entries) is stamped with at creation time. Nothing is ever deleted for
// a "reset" — a new week just means a new week_key, so history/audit
// trail is preserved for disputes and duplicate-fraud checks.
//
// NOTE: this uses UTC (matching SQLite's `datetime('now')`, which is also
// UTC) rather than the server's local timezone, so week_key stays
// consistent with created_at/verified_at timestamps already in the DB.
// If exact US-local midnight boundaries ever matter, adjust here.

function startOfUTCDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// Returns the week_key (YYYY-MM-DD of the relevant Saturday) that `date`
// should be attributed to for earning purposes.
function getWeekKey(date = new Date()) {
  const d = startOfUTCDay(date);
  const dow = d.getUTCDay(); // 0=Sun .. 5=Fri .. 6=Sat

  if (dow === 5) {
    // Friday — draw/lock day. New activity rolls into next week.
    d.setUTCDate(d.getUTCDate() + 1);
  } else {
    const daysSinceSaturday = (dow + 1) % 7; // Sat->0, Sun->1, Mon->2 ... Thu->5
    d.setUTCDate(d.getUTCDate() - daysSinceSaturday);
  }

  return d.toISOString().slice(0, 10);
}

// Returns { start, end } Date objects (UTC) for a given week_key, where
// end is exclusive (start of the following Saturday).
function getWeekRange(weekKey) {
  const start = new Date(`${weekKey}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

module.exports = { getWeekKey, getWeekRange };
