// One-time backfill: give every CURRENT Discord server member an account +
// their free weekly entry, without requiring them to log in to the site.
// This mirrors exactly what discord-bot.js's guildMemberAdd handler does,
// just run once over the full existing member list instead of one join at
// a time. Safe to re-run — everything it touches is idempotent (INSERT ...
// ON CONFLICT / existing-row checks), so running it twice just no-ops for
// members already granted this week.
//
// Usage (from repo root, wherever DISCORD_BOT_TOKEN / DISCORD_GUILD_ID /
// the db are available — e.g. the Railway console):
//   node backend/scripts/backfill-members.js

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const db = require('../db/db');
const { grantWeeklyDiscordEntry } = require('../routes/entries');

const GUILD_ID = process.env.DISCORD_GUILD_ID;
if (!GUILD_ID) {
  console.error('DISCORD_GUILD_ID is not set — aborting.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

client.once('ready', async () => {
  try {
    console.log(`Logged in as ${client.user.tag}. Fetching guild ${GUILD_ID}...`);
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch(); // requires Server Members Intent
    console.log(`Fetched ${members.size} members. Processing...`);

    let created = 0, granted = 0, skippedBots = 0;

    for (const member of members.values()) {
      if (member.user.bot) { skippedBots++; continue; }

      let user = db.prepare(`SELECT * FROM users WHERE discord_id = ?`).get(member.id);
      if (!user) {
        const info = db.prepare(`
          INSERT INTO users (discord_id, discord_username) VALUES (?, ?)
        `).run(member.id, member.user.username);
        user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
        created++;
      }

      db.prepare(`
        INSERT INTO social_verifications (user_id, platform, method, is_following, verified_at)
        VALUES (?, 'discord', 'automated', 1, datetime('now'))
        ON CONFLICT(user_id, platform) DO UPDATE SET is_following = 1, verified_at = datetime('now')
      `).run(user.id);

      if (grantWeeklyDiscordEntry(user.id)) granted++;
    }

    console.log(`Done. ${created} new user accounts created, ${granted} free entries granted, ${skippedBots} bots skipped.`);
  } catch (err) {
    console.error('Backfill failed:', err);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
