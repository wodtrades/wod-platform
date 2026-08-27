require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits
} = require('discord.js');
const path = require('path');
const Database = require('better-sqlite3');

// Shares the SAME database file as the web backend — no separate sync needed.
const db = new Database(path.join(__dirname, '..', 'backend', 'db', 'wod.sqlite'));

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const ADMIN_USER_IDS = (process.env.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // required for role sync + leave detection
  ]
});

// ---------------------------------------------------------------
// SLASH COMMANDS
// ---------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('draw')
    .setDescription('Draw winners for a prop firm giveaway (admin only)')
    .addStringOption(opt =>
      opt.setName('firm')
        .setDescription('Which firm to draw for')
        .setRequired(true)
        .addChoices(
          { name: 'Lucid Trading', value: 'lucidtrading' },
          { name: 'Tradeify', value: 'tradeify' },
          { name: 'Alpha Futures', value: 'alphafutures' },
        ))
    .addIntegerOption(opt =>
      opt.setName('count')
        .setDescription('Number of winners to draw')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('pending')
    .setDescription('Check how many order numbers are waiting on manual verification (admin only)'),
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log('Slash commands registered.');
}

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

// ---------------------------------------------------------------
// ROLE SYNC — every 5 min, give the Verified role to anyone whose
// Discord verification is on file. Cheap and self-healing.
// ---------------------------------------------------------------
async function syncVerifiedRoles() {
  if (!VERIFIED_ROLE_ID) return;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const verifiedRows = db.prepare(`
      SELECT users.discord_id FROM social_verifications
      JOIN users ON users.id = social_verifications.user_id
      WHERE social_verifications.platform = 'discord' AND social_verifications.is_following = 1
    `).all();

    for (const row of verifiedRows) {
      try {
        const member = await guild.members.fetch(row.discord_id);
        if (!member.roles.cache.has(VERIFIED_ROLE_ID)) {
          await member.roles.add(VERIFIED_ROLE_ID);
        }
      } catch {
        // member not found (likely left) — leave-detection handler covers this separately
      }
    }
  } catch (err) {
    console.error('Role sync failed:', err.message);
  }
}

// ---------------------------------------------------------------
// LEAVE DETECTION — if someone verified Discord membership and then
// leaves, flag any entries tied to them for admin review instead of
// silently letting them keep an entry earned by membership they no
// longer hold.
// ---------------------------------------------------------------
client.on('guildMemberRemove', (member) => {
  const user = db.prepare(`SELECT * FROM users WHERE discord_id = ?`).get(member.id);
  if (!user) return;

  db.prepare(`
    UPDATE social_verifications SET is_following = 0
    WHERE user_id = ? AND platform = 'discord'
  `).run(user.id);

  const entries = db.prepare(`
    SELECT id FROM entries WHERE user_id = ? AND verification_status IN ('pending','approved')
  `).all(user.id);

  for (const entry of entries) {
    db.prepare(`
      UPDATE entries SET admin_notes = COALESCE(admin_notes || ' | ', '') || 'FLAGGED: user left Discord after verifying'
      WHERE id = ?
    `).run(entry.id);
  }

  db.prepare(`INSERT INTO audit_log (user_id, action, details) VALUES (?, 'left_discord_after_verify', ?)`)
    .run(user.id, JSON.stringify({ entries_flagged: entries.length }));

  console.log(`${member.user.tag} left — flagged ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} for review.`);
});

// ---------------------------------------------------------------
// COMMAND HANDLERS
// ---------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!isAdmin(interaction.user.id)) {
    return interaction.reply({ content: "This command is admin-only.", ephemeral: true });
  }

  if (interaction.commandName === 'pending') {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM entries
      WHERE entry_type = 'bonus' AND verification_status = 'pending'
    `).get();
    return interaction.reply({
      content: `**${row.count}** order number${row.count === 1 ? '' : 's'} waiting on manual verification.`,
      ephemeral: true
    });
  }

  if (interaction.commandName === 'draw') {
    await interaction.deferReply();

    const firm = interaction.options.getString('firm');
    const count = interaction.options.getInteger('count');

    // Draw pool = approved base entries + approved bonus entries for this firm
    const pool = db.prepare(`
      SELECT entries.*, users.discord_id, users.discord_username
      FROM entries
      JOIN users ON users.id = entries.user_id
      WHERE entries.verification_status = 'approved'
        AND (entries.entry_type = 'base' OR entries.prop_firm = ?)
    `).all(firm);

    if (pool.length === 0) {
      return interaction.editReply(`No approved entries found for ${firm} yet.`);
    }
    if (count > pool.length) {
      return interaction.editReply(`Only ${pool.length} eligible entries — can't draw ${count}.`);
    }

    // Simple random draw, no repeat winners within this draw
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const winners = shuffled.slice(0, count);

    db.prepare(`
      INSERT INTO giveaway_draws (draw_date, total_entries_in_draw, winners_json, drawn_at)
      VALUES (datetime('now'), ?, ?, datetime('now'))
    `).run(pool.length, JSON.stringify(winners.map(w => ({
      user_id: w.user_id, entry_id: w.id, prop_firm: firm
    }))));

    const embed = new EmbedBuilder()
      .setTitle(`🏆 ${firm} Giveaway Winners`)
      .setColor(0xE8A33D)
      .setDescription(winners.map(w => `<@${w.discord_id}>`).join('\n'))
      .setFooter({ text: `Drawn from ${pool.length} eligible entries` })
      .setTimestamp();

    const channel = ANNOUNCE_CHANNEL_ID
      ? await client.channels.fetch(ANNOUNCE_CHANNEL_ID)
      : interaction.channel;
    await channel.send({ embeds: [embed] });

    for (const w of winners) {
      try {
        const user = await client.users.fetch(w.discord_id);
        await user.send(`You won a **${firm}** evaluation account in the WOD giveaway! We'll be in touch with next steps. 🎉`);
      } catch {
        // DMs closed — winner still gets the public announcement
      }
    }

    await interaction.editReply(`Drew ${winners.length} winner(s) for ${firm} and posted the announcement.`);
  }
});

client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  syncVerifiedRoles();
  setInterval(syncVerifiedRoles, 5 * 60 * 1000);
});

registerCommands().then(() => client.login(process.env.DISCORD_BOT_TOKEN));
