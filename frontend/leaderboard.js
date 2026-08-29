// WOD — leaderboard.html page logic
// Relies on the API helper functions defined in script.js

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Public — loads regardless of login state.
  await loadBoard();

  const user = await checkLoginStatus();
  if (!user) {
    // logged-out state is shown by default; nothing else to do
    return;
  }
  document.getElementById('logged-out-state').classList.add('hidden');
  document.getElementById('logged-in-state').classList.remove('hidden');

  await Promise.all([loadDash(), refreshStatus()]);
}

async function loadBoard() {
  const data = await loadLeaderboard();
  const body = document.getElementById('leaderboard-body');
  if (!data || !data.leaderboard.length) {
    body.innerHTML = '<tr><td colspan="3" class="muted">No entries yet this week — be the first.</td></tr>';
    return;
  }

  // Medal emojis for top 3
  const medals = ['👑', '🥈', '🥉'];

  body.innerHTML = data.leaderboard.map((row, i) => {
    const rank = i + 1;
    const medal = rank <= 3 ? medals[rank - 1] : rank;
    return `
      <tr>
        <td>${medal}</td>
        <td>${row.discord_username}</td>
        <td>${row.total_entries}</td>
      </tr>
    `;
  }).join('');

  // Store leaderboard data for user rank display
  window.leaderboardData = data.leaderboard;
}

// Turns a "YYYY-MM-DD" week_key into "August 22, 2026". Built from the
// parts (not `new Date(weekKey)` directly) and formatted with timeZone:
// 'UTC' so the displayed date can't drift a day off depending on the
// visitor's local timezone.
function formatWeekDate(weekKey) {
  if (!weekKey) return '';
  const [year, month, day] = weekKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

async function loadDash() {
  const data = await loadDashboard();
  if (!data) return;

  document.getElementById('week-label').textContent = `week of ${formatWeekDate(data.week_key)}`;
  document.getElementById('dash-base').textContent = data.summary.base_entries;
  document.getElementById('dash-referrals').textContent = data.summary.referral_entries;

  let ordersText = String(data.summary.order_entries);
  if (data.summary.order_entries_pending > 0) {
    ordersText += ` (+${data.summary.order_entries_pending} pending)`;
  }
  document.getElementById('dash-orders').textContent = ordersText;
  document.getElementById('dash-total').textContent = data.summary.total_entries;

  // Show user's rank
  showUserRank(data.summary.total_entries);
}

async function refreshStatus() {
  const data = await loadMyEntries();
  if (!data) return;
  entriesState.entries = data.entries;
  entriesState.currentWeekKey = data.current_week_key;
  entriesState.expanded = false;
  renderEntriesTable();
}

// Turns a "YYYY-MM-DD" week_key into "08-22-2026" for the Entry Log table.
function formatWeekDateNumeric(weekKey) {
  if (!weekKey) return '—';
  const [year, month, day] = weekKey.split('-');
  return `${month}-${day}-${year}`;
}

function entryLabel(e) {
  if (e.entry_type === 'base') return 'Free entry';
  if (e.source === 'referral') return 'Referral entry';
  return 'Order entry';
}

// Entry Log only shows the 5 most recent entries by default — the toggle
// button below the table expands to the full history on demand, same
// pattern as the admin panel's draw-pool table.
const ENTRIES_PAGE_SIZE = 5;
const entriesState = { entries: [], currentWeekKey: null, expanded: false };

function renderEntriesTable() {
  const { entries, currentWeekKey, expanded } = entriesState;
  const body = document.getElementById('my-entries-body');
  const toggleWrap = document.getElementById('entries-toggle-wrap');
  const toggleBtn = document.getElementById('entries-toggle-btn');

  if (!entries.length) {
    body.innerHTML = '<tr><td colspan="4" class="muted">No entries yet.</td></tr>';
    toggleWrap.classList.add('hidden');
    return;
  }

  const visible = expanded ? entries : entries.slice(0, ENTRIES_PAGE_SIZE);
  body.innerHTML = visible.map(e => `
    <tr${e.week_key === currentWeekKey ? ' style="font-weight: 600;"' : ''}>
      <td>${entryLabel(e)}</td>
      <td>${e.prop_firm || '—'}</td>
      <td>${formatWeekDateNumeric(e.week_key)}${e.week_key === currentWeekKey ? ' (this week)' : ''}</td>
      <td>${e.verification_status}</td>
    </tr>
  `).join('');

  if (entries.length > ENTRIES_PAGE_SIZE) {
    toggleWrap.classList.remove('hidden');
    toggleBtn.textContent = expanded ? 'Show recent 5 only' : `Show all ${entries.length} ▾`;
  } else {
    toggleWrap.classList.add('hidden');
  }
}

function toggleEntriesView() {
  entriesState.expanded = !entriesState.expanded;
  renderEntriesTable();
}

// Calculate user's rank based on their total entries
function showUserRank(userTotalEntries) {
  if (!window.leaderboardData || !window.leaderboardData.length) {
    return;
  }

  // Find user's rank by counting how many have more entries
  let userRank = 1;
  for (const row of window.leaderboardData) {
    if (row.total_entries > userTotalEntries) {
      userRank++;
    }
  }

  // Show the rank section and populate it
  const rankSection = document.getElementById('your-rank-section');
  const rankNumber = document.getElementById('user-rank-number');
  const rankEntries = document.getElementById('user-rank-entries');

  rankSection.classList.remove('hidden');
  rankNumber.textContent = `#${userRank}`;
  rankEntries.textContent = userTotalEntries;
}
