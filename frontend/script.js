// WOD — frontend entry logic
// This talks to the backend routes in /backend/routes/entries.js and /backend/routes/auth.js

const API_BASE = ''; // same-origin when served by the backend; set a full URL if hosted separately

async function checkLoginStatus() {
  const res = await fetch(`${API_BASE}/auth/me`);
  if (res.ok) {
    const { user } = await res.json();
    return user;
  }
  return null;
}

async function submitOrderEntry(propFirm, orderNumber) {
  const res = await fetch(`${API_BASE}/api/entries/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prop_firm: propFirm, order_number: orderNumber })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong submitting your order.');
  }
  return data;
}

async function selfReportSocial(platform) {
  const res = await fetch(`${API_BASE}/api/entries/social/self-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong saving that.');
  }
  return data;
}

async function loadMyEntries() {
  const res = await fetch(`${API_BASE}/api/entries/me`);
  if (!res.ok) return null;
  return res.json();
}

async function loadDashboard() {
  const res = await fetch(`${API_BASE}/api/entries/dashboard`);
  if (!res.ok) return null;
  return res.json();
}

async function loadLeaderboard() {
  const res = await fetch(`${API_BASE}/api/entries/leaderboard`);
  if (!res.ok) return null;
  return res.json();
}

// Copy code to clipboard
function copyCodeToClipboard(code, buttonEl) {
  navigator.clipboard.writeText(code).then(() => {
    if (buttonEl.textContent.trim()) {
      const originalText = buttonEl.textContent;
      buttonEl.textContent = 'Copied!';
      setTimeout(() => {
        buttonEl.textContent = originalText;
      }, 2000);
    } else {
      showCopyToast(buttonEl);
    }
  }).catch(err => {
    console.error('Failed to copy:', err);
  });
}

// Small floating "Copied!" toast for icon-only copy buttons (e.g. image overlays)
function showCopyToast(buttonEl) {
  const toast = document.createElement('span');
  toast.className = 'copy-toast';
  toast.textContent = 'Copied!';
  buttonEl.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => toast.remove(), 1400);
}

// Live Discord member count for the homepage hero stat block
async function loadDiscordMemberCount() {
  const el = document.getElementById('discord-member-count');
  if (!el) return;
  try {
    const res = await fetch(`${API_BASE}/api/discord/member-count`);
    if (!res.ok) return;
    const { count } = await res.json();
    if (typeof count === 'number') {
      el.textContent = count.toLocaleString();
    }
  } catch (err) {
    console.error('Failed to load Discord member count:', err);
  }
}

document.addEventListener('DOMContentLoaded', loadDiscordMemberCount);
