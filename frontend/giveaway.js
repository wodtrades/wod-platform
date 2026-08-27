// WOD — giveaways.html page logic
// Relies on the API helper functions defined in script.js

document.addEventListener('DOMContentLoaded', init);

async function init() {
  startCountdown(); // runs regardless of login state

  const user = await checkLoginStatus();
  if (user) {
    document.getElementById('logged-out-state').classList.add('hidden');
  }
  // Free Entry checklist is visible to everyone, logged in or not —
  // refreshChecklist() populates real status when logged in and just
  // leaves the default unverified state otherwise.
  await refreshChecklist();
}

// ---- Free Entry checklist ----
async function refreshChecklist() {
  const data = await loadMyEntries();
  if (!data) return; // not logged in — checklist stays in its default state

  renderChecklist(data.socials);

  const baseEntryThisWeek = data.entries.find(e => e.entry_type === 'base' && e.week_key === data.current_week_key);
  document.getElementById('base-entry-banner').classList.toggle('hidden', !baseEntryThisWeek);
}

function renderChecklist(socials) {
  const verifiedPlatforms = new Set(
    socials.filter(s => s.is_following).map(s => s.platform)
  );
  document.querySelectorAll('.check-item').forEach(item => {
    const platform = item.dataset.platform;
    const verified = verifiedPlatforms.has(platform);
    item.classList.toggle('verified', verified);
    const statusEl = item.querySelector('.check-status');
    if (statusEl) statusEl.textContent = verified ? 'Verified ✓' : 'Automated';
    const btn = item.querySelector('button');
    if (btn && verified) {
      btn.textContent = 'Verified ✓';
      btn.disabled = true;
    }
  });
}

async function reportSocial(platform) {
  const note = document.getElementById('checklist-note');
  try {
    await selfReportSocial(platform);
    note.classList.add('hidden');
    await refreshChecklist();
  } catch (err) {
    note.textContent = err.message === 'not logged in'
      ? 'Connect Discord above first, then you can verify your other socials.'
      : err.message;
    note.classList.remove('hidden');
  }
}

// ---- Countdown to every Friday at 11:00 AM Eastern — winners are drawn
// in the Discord every Friday at 11am ET, so the deadline always rolls
// forward to the next upcoming one. Eastern automatically flips between
// EST/EDT depending on the date, so the target is computed against the
// America/New_York wall clock (via Intl) rather than a fixed UTC offset —
// there's no timezone library in this codebase, so this does it by hand. ----
const DRAW_TZ = 'America/New_York';
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Reads the wall-clock date/time as it appears in `timeZone` for a given
// UTC instant.
function getZonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
  });
  const parts = {};
  dtf.formatToParts(date).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // midnight edge case some locales render as "24"
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour, minute: parseInt(parts.minute, 10), second: parseInt(parts.second, 10),
    weekday: parts.weekday
  };
}

// Converts a y/m/d/h/m/s wall-clock time *as it should read in timeZone*
// into the real UTC instant it represents. Standard "guess, then correct by
// the observed offset" trick — DST-safe without any date library.
function zonedTimeToUtc(y, month, d, hh, mm, ss, timeZone) {
  const guess = Date.UTC(y, month - 1, d, hh, mm, ss);
  const asIfUtc = getZonedParts(new Date(guess), timeZone);
  const reinterpreted = Date.UTC(asIfUtc.year, asIfUtc.month - 1, asIfUtc.day, asIfUtc.hour, asIfUtc.minute, asIfUtc.second);
  const offset = reinterpreted - guess;
  return new Date(guess - offset);
}

function nextFridayDeadline() {
  const nowParts = getZonedParts(new Date(), DRAW_TZ);
  const daysUntilFriday = (5 - WEEKDAY_INDEX[nowParts.weekday] + 7) % 7; // 0 if today is Friday (ET)

  // Calendar-date arithmetic on the NY "today" — Date.UTC here is just a
  // convenient day-math scratchpad, not yet a real instant.
  const base = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day));
  base.setUTCDate(base.getUTCDate() + daysUntilFriday);

  let target = zonedTimeToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 11, 0, 0, DRAW_TZ);
  if (target <= new Date()) {
    base.setUTCDate(base.getUTCDate() + 7);
    target = zonedTimeToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 11, 0, 0, DRAW_TZ);
  }
  return target;
}

function startCountdown() {
  // Supports any number of countdown widgets on the page — each unit
  // element is matched by data-cd="days|hours|minutes|seconds" rather
  // than a single fixed id, so the big countdown banner and the compact
  // "DRAW IN" promo widget both stay in sync off one timer.
  const daysEls = document.querySelectorAll('[data-cd="days"]');
  const hoursEls = document.querySelectorAll('[data-cd="hours"]');
  const minutesEls = document.querySelectorAll('[data-cd="minutes"]');
  const secondsEls = document.querySelectorAll('[data-cd="seconds"]');
  if (!daysEls.length || !hoursEls.length || !minutesEls.length || !secondsEls.length) return; // no countdown markup on this page

  let target = nextFridayDeadline();

  function pad(n) { return String(n).padStart(2, '0'); }
  function setAll(els, text) { els.forEach(el => { el.textContent = text; }); }

  function tick() {
    const now = new Date();
    let diff = target - now;
    if (diff <= 0) {
      target = nextFridayDeadline();
      diff = target - now;
    }
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff / 3600000) % 24);
    const minutes = Math.floor((diff / 60000) % 60);
    const seconds = Math.floor((diff / 1000) % 60);
    setAll(daysEls, pad(days));
    setAll(hoursEls, pad(hours));
    setAll(minutesEls, pad(minutes));
    setAll(secondsEls, pad(seconds));
  }

  tick();
  setInterval(tick, 1000);
}

function toggleOrderRow(headerBtn) {
  const row = headerBtn.closest('.order-row');
  if (!row) return;
  const wasExpanded = row.classList.contains('expanded');
  // Only one row open at a time, like a standard accordion.
  document.querySelectorAll('.order-row.expanded').forEach(r => r.classList.remove('expanded'));
  if (!wasExpanded) {
    row.classList.add('expanded');
    const input = row.querySelector('.order-input');
    if (input) setTimeout(() => input.focus(), 200);
  }
}

async function submitOrder(firm, buttonEl) {
  const card = buttonEl.closest('.order-row');
  const input = card.querySelector('.order-input');
  const statusEl = card.querySelector('.order-status');
  const orderNumber = input.value.trim();

  if (!orderNumber) {
    statusEl.textContent = 'Enter an order number first.';
    statusEl.className = 'order-status error';
    return;
  }

  statusEl.textContent = 'Submitting…';
  statusEl.className = 'order-status';

  buttonEl.disabled = true;
  try {
    await submitOrderEntry(firm, orderNumber);
    statusEl.textContent = 'Entry added! Bought another account this week? Log its order number too.';
    statusEl.className = 'order-status approved';
    input.value = '';
  } catch (err) {
    statusEl.textContent = err.message === 'not logged in'
      ? 'Connect Discord above first, then submit.'
      : err.message;
    statusEl.className = 'order-status error';
  } finally {
    buttonEl.disabled = false;
  }
}
