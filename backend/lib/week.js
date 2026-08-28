// Giveaway week boundaries.
//
// A giveaway "week" runs Saturday 00:00 ET through the following Friday
// 11:00 AM ET — winners are drawn in the Discord every Friday at 11am
// Eastern (see the countdown in frontend/giveaway.js), so that's the real
// lock/draw moment: anything logged before 11am ET on Friday is still
// part of the week being drawn that day; anything at/after 11am ET on
// Friday is attributed to the NEXT week's pool (the draw for the current
// week has already started/happened), not rejected.
//
// IMPORTANT: this is anchored to America/New_York (ET) specifically
// because that's the real-world timezone the Friday 11am draw happens
// in — using UTC here (as this file originally did) causes the week to
// flip over ~4-5 hours too early (UTC crosses into "Friday" around
// 8-9pm Thursday Eastern), silently hiding that day's entries from the
// current week's leaderboard and misrouting new submissions hours
// before the actual draw. Fixed 2026-08-27 after that exact bug showed
// up live on a Thursday night, the night before a Friday draw.
//
// week_key is the ISO date (YYYY-MM-DD, in ET calendar terms) of that
// week's Saturday, and is what every weekly-scoped row (base entries,
// order entries, referral entries) is stamped with at creation time.
// Nothing is ever deleted for a "reset" — a new week just means a new
// week_key, so history/audit trail is preserved for disputes and
// duplicate-fraud checks.

const TIME_ZONE = 'America/New_York';
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Returns { year, month, day, hour, minute, weekday } as WALL-CLOCK values
// in the giveaway's reference timezone (America/New_York) for the given
// instant. `weekday` uses the same 0=Sun..6=Sat convention as
// Date#getUTCDay(). Handles DST automatically via the JS engine's ICU
// data — no manual offset math or extra dependency needed.
function getEasternParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'short'
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    parts[type] = value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday]
  };
}

// Converts ET wall-clock components (year/month/day/hour/minute) to the
// actual UTC Date instant they represent — the inverse of getEasternParts.
// Standard guess-and-correct approach: treat the wall-clock values as if
// they were UTC, see what ET time that instant actually formats to, then
// shift by the difference. One correction pass is sufficient outside the
// handful of DST-transition minutes twice a year, which don't matter here.
function easternWallTimeToUtc(year, month, day, hour, minute) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const asEt = getEasternParts(guess);
  const guessedAsUtcMs = Date.UTC(asEt.year, asEt.month - 1, asEt.day, asEt.hour, asEt.minute);
  const wantedMs = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(guess.getTime() + (wantedMs - guessedAsUtcMs));
}

// Returns the week_key (YYYY-MM-DD of the relevant Saturday, in ET
// calendar terms) that `date` should be attributed to for earning
// purposes.
function getWeekKey(date = new Date()) {
  const et = getEasternParts(date);
  // Vessel for calendar-date arithmetic only — NOT a real UTC instant,
  // just ET's Y/M/D carried in a Date so setUTCDate()/toISOString() work.
  const d = new Date(Date.UTC(et.year, et.month - 1, et.day));

  if (et.weekday === 5 && et.hour >= 11) {
    // Friday at/after 11:00 AM ET — draw is happening/has happened.
    // New activity rolls into next week's pool (the upcoming Saturday).
    d.setUTCDate(d.getUTCDate() + 1);
  } else {
    // Sat->0, Sun->1, Mon->2 ... Thu->5, Fri(before 11am)->6 — Friday
    // morning correctly lands back on that same week's Saturday, since
    // the draw for the current week hasn't happened yet.
    const daysSinceSaturday = (et.weekday + 1) % 7;
    d.setUTCDate(d.getUTCDate() - daysSinceSaturday);
  }

  return d.toISOString().slice(0, 10);
}

// Returns { start, end } Date objects (real UTC instants) for a given
// week_key: start = that Saturday 00:00 ET, end = the following Friday
// 11:00 AM ET (the draw moment), exclusive.
function getWeekRange(weekKey) {
  const [year, month, day] = weekKey.split('-').map(Number);
  const start = easternWallTimeToUtc(year, month, day, 0, 0);

  const fridayCalendar = new Date(Date.UTC(year, month - 1, day));
  fridayCalendar.setUTCDate(fridayCalendar.getUTCDate() + 6); // Saturday + 6 = following Friday
  const end = easternWallTimeToUtc(
    fridayCalendar.getUTCFullYear(),
    fridayCalendar.getUTCMonth() + 1,
    fridayCalendar.getUTCDate(),
    11, 0
  );

  return { start, end };
}

module.exports = { getWeekKey, getWeekRange };
