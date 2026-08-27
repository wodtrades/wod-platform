// WOD — referral.html page logic
// Relies on the API helper functions defined in script.js

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const user = await checkLoginStatus();
  if (!user) {
    // logged-out state is shown by default; nothing else to do
    return;
  }
  document.getElementById('logged-out-state').classList.add('hidden');
  document.getElementById('logged-in-state').classList.remove('hidden');

  await loadDash();

  const copyBtn = document.getElementById('copy-referral-btn');
  const linkInput = document.getElementById('referral-link-input');
  if (copyBtn && linkInput) {
    copyBtn.addEventListener('click', () => copyCodeToClipboard(linkInput.value, copyBtn));
  }
}

// This week's entry breakdown + leaderboard now live on /leaderboard — this
// page only needs the referral link itself.
async function loadDash() {
  const data = await loadDashboard();
  if (!data) return;

  document.getElementById('referral-link-input').value = data.referral_link;
}
