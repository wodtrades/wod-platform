require("dotenv").config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const db = require("./db/db");
const { submitOrderEntry, OrderEntryError, grantWeeklyDiscordEntry, revokeDiscordEntry } = require("./routes/entries");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // needed for guildMemberAdd below — enable "Server Members Intent" in the dev portal
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ---------------------------------------------------------------
// Anyone who joins the server — through any path (a website CTA, a raw
// invite link, someone else's invite, whatever) — gets an account and
// their free weekly entry automatically. This is what makes "everyone
// currently in the Discord already gets a free entry" and "any future
// join gets one too" both true, independent of how they got there.
// ---------------------------------------------------------------
client.on("guildMemberAdd", async member => {
  try {
    if (member.user.bot) return;
    if (process.env.DISCORD_GUILD_ID && member.guild.id !== process.env.DISCORD_GUILD_ID) return;

    let user = db.prepare(`SELECT * FROM users WHERE discord_id = ?`).get(member.id);
    if (!user) {
      const info = db.prepare(`
        INSERT INTO users (discord_id, discord_username) VALUES (?, ?)
      `).run(member.id, member.user.username);
      user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
    }

    db.prepare(`
      INSERT INTO social_verifications (user_id, platform, method, is_following, verified_at)
      VALUES (?, 'discord', 'automated', 1, datetime('now'))
      ON CONFLICT(user_id, platform) DO UPDATE SET is_following = 1, verified_at = datetime('now')
    `).run(user.id);

    grantWeeklyDiscordEntry(user.id);
  } catch (err) {
    console.error("guildMemberAdd handler error:", err);
  }
});

// ---------------------------------------------------------------
// Anyone who leaves the server — kicked, banned, or leaves on their
// own — immediately loses this week's free entry and stops qualifying
// for future weekly entries until they rejoin. Mirrors guildMemberAdd
// above so "in the Discord" stays continuously enforced, not just
// checked once at signup.
// ---------------------------------------------------------------
client.on("guildMemberRemove", async member => {
  try {
    if (member.user.bot) return;
    if (process.env.DISCORD_GUILD_ID && member.guild.id !== process.env.DISCORD_GUILD_ID) return;

    const user = db.prepare(`SELECT * FROM users WHERE discord_id = ?`).get(member.id);
    if (!user) return; // never had an account on our side — nothing to revoke

    const revoked = revokeDiscordEntry(user.id);
    console.log(`${member.user.username} left the Discord — social verification revoked${revoked ? ", this week's free entry pulled back" : ""}.`);
  } catch (err) {
    console.error("guildMemberRemove handler error:", err);
  }
});

client.once("ready", async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  const commands = [
    new SlashCommandBuilder()
      .setName("verify-order")
      .setDescription("Log an order number for a code WOD purchase")
      .addStringOption(option =>
        option.setName("firm").setDescription("Prop firm").setRequired(true)
          .addChoices(
            { name: "Lucid Trading", value: "lucidtrading" },
            { name: "Tradeify", value: "tradeify" },
            { name: "AlphaFutures", value: "alphafutures" }
          )
      )
      .addStringOption(option =>
        option.setName("order-number").setDescription("Your order number").setRequired(true)
      )
      .toJSON()
  ];
  await client.application.commands.set(commands);
  console.log("✅ Slash commands registered");
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "verify-order") return;

  const firm = interaction.options.getString("firm");
  const orderNumber = interaction.options.getString("order-number").trim().toUpperCase();

  let user = db.prepare(`SELECT id FROM users WHERE discord_id = ?`).get(interaction.user.id);
  if (!user && process.env.DEV_MODE === "true") {
    const info = db.prepare(`INSERT INTO users (discord_id, discord_username) VALUES (?, ?)`).run(interaction.user.id, interaction.user.username);
    user = { id: info.lastInsertRowid };
  }
  if (!user) {
    return interaction.reply({ content: "❌ Log in to the giveaway site with Discord first.", ephemeral: true });
  }

  try {
    // Shared with the website's POST /api/entries/order — same validation,
    // same duplicate check, same instant-approve, same referral trigger.
    // No allowlist check here: entries are approved instantly, and the
    // real fraud check is the weekly CSV reconciliation the admin runs
    // before the Friday draw (see routes/admin.js), not this submission step.
    const result = submitOrderEntry(user.id, firm, orderNumber);
    const embed = new EmbedBuilder()
      .setColor(0x35C48A)
      .setTitle("✅ Entry Logged")
      .setDescription(`Your **${firm}** order (\`${orderNumber}\`) has been added to your entries for this week.\n\nEntries are confirmed against the affiliate records before Friday's draw — make sure this order number is exact.`)
      .setTimestamp();
    interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    if (err instanceof OrderEntryError) {
      return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
    console.error("Error:", err);
    interaction.reply({ content: "❌ Error. Contact admin.", ephemeral: true });
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
