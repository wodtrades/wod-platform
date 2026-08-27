const express = require('express');
const router = express.Router();

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache = { count: null, fetchedAt: 0 };

async function fetchMemberCount() {
  if (!BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not configured');

  // The bot only lives in one server, so we don't need a pre-configured
  // DISCORD_GUILD_ID — just ask Discord which guild(s) the bot is in.
  const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { Authorization: `Bot ${BOT_TOKEN}` }
  });
  if (!guildsRes.ok) {
    throw new Error(`Failed to list bot guilds: ${guildsRes.status} ${await guildsRes.text()}`);
  }
  const guilds = await guildsRes.json();
  if (!guilds.length) throw new Error('Bot is not currently in any Discord server');

  const guildId = guilds[0].id;

  const guildRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}?with_counts=true`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` }
  });
  if (!guildRes.ok) {
    throw new Error(`Failed to fetch guild info: ${guildRes.status} ${await guildRes.text()}`);
  }
  const guild = await guildRes.json();
  return guild.approximate_member_count;
}

router.get('/member-count', async (req, res) => {
  const now = Date.now();
  if (cache.count !== null && now - cache.fetchedAt < CACHE_TTL_MS) {
    return res.json({ count: cache.count, cached: true });
  }

  try {
    const count = await fetchMemberCount();
    cache = { count, fetchedAt: now };
    res.json({ count, cached: false });
  } catch (err) {
    console.error('Discord member-count fetch failed:', err.message);
    // Serve stale cache if we have it, instead of erroring out the homepage
    if (cache.count !== null) {
      return res.json({ count: cache.count, cached: true, stale: true });
    }
    res.status(502).json({ error: 'Unable to fetch member count' });
  }
});

module.exports = router;
