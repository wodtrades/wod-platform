// One-time backfill: grants the free weekly entry to everyone who is
// ALREADY in the Discord server right now, without requiring them to
// visit the site or log in. Safe to re-run — grantWeeklyDiscordEntry()
// is a no-op for anyone who already has this week's entry.
//
// Usage:  node scripts/backfill-discord-members.js
//
// Requires DISCORD_BOT_TOKEN + DISCORD_GUILD_ID in .env, and the
// "Server Members Intent" toggle enabled in the Discord Developer Portal
// (Bot page > Privileged Gateway Intents) — otherwise the member list
// fetch below will come back empty or error out.

require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const db = require("../db/db");
const { grantWeeklyDiscordEntry } = require("../routes/entries");

const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!GUILD_ID) {
  console.error("DISCORD_GUILD_ID is not set in .env — aborting.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}. Fetching guild ${GUILD_ID}...`);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch(); // requires Server Members Intent
    console.log(`Fetched ${members.size} members.`);

    let created = 0;
    let granted = 0;

    for (const member of members.values()) {
      if (member.user.bot) continue;

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

    console.log(`Done. ${created} new accounts created, ${granted} free entries granted this run.`);
  } catch (err) {
    console.error("Backfill failed:", err.message);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
