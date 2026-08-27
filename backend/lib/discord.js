// Thin wrapper around Discord's REST API, using the bot token — for
// server-triggered actions (like the admin panel posting the weekly
// winners announcement) that don't go through the discord-bot.js
// gateway process. Bot token has permission to post in any channel
// it's been given access to in the server settings.

async function postToDiscordChannel(channelId, content) {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      content,
      // Only actually ping the users named in the message (winner
      // mentions) — never @everyone/@here, even if that text somehow
      // ends up in the content.
      allowed_mentions: { parse: ['users'] }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Discord API error ${res.status}: ${errText}`);
  }

  return res.json();
}

module.exports = { postToDiscordChannel };
