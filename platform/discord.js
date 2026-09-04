// platform/discord.js — thin discord.js (v14) adapter. Same shape as slack.js:
// maps discord events/commands onto the platform-agnostic core.
//
// Greenfield notes (see README "Discord setup"):
//   - Discord bot token (DISCORD_BOT_TOKEN)
//   - Intents: GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT, GUILD_MESSAGE_REACTIONS
//   - SNIPE_CHANNEL_ID set to the Discord channel ID where sniping happens
//   - /snipe* commands registered via the discord CLI or the app below
//
// discord.js is an optional dependency: if it isn't installed, start() throws
// a clear error and index.js just skips the Discord platform.
const core = require("../core");

// Discord owns its channel (separate from Slack's SNIPE_CHANNEL_ID) so both
// platforms can run side by side.
const SNIPE_CHANNEL = process.env.DISCORD_SNIPE_CHANNEL_ID;

let Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes;
try {
  ({ Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require("discord.js"));
} catch (err) {
  if (err.code === "MODULE_NOT_FOUND") {
    Client = null;
    console.warn("discord.js not installed — Discord platform will be skipped. Run: npm i discord.js");
  } else {
    throw err;
  }
}

// Discord renders mentions as <@ID> (same shape as Slack).
core.setFormatMention((id) => `<@${id}>`);

// Injected render API — what core needs to touch the platform.
// channel is the Discord channel ID (string).
const api = {
  async addReaction(channel, ts, name) {
    const msg = await client.channels.cache.get(channel)?.messages.fetch(ts).catch(() => null);
    if (msg) await msg.reactions.cache.get(name)?.fetch().catch(() => {});
    if (msg) await msg.react(name).catch(() => {});
  },
  async removeReaction(channel, ts, name) {
    const msg = await client.channels.cache.get(channel)?.messages.fetch(ts).catch(() => null);
    if (msg) await msg.reactions.remove(name).catch(() => {});
  },
  async postEphemeral(channel, user, text) {
    const ch = client.channels.cache.get(channel);
    if (ch) await ch.send({ content: text, dm: true, userId: user }).catch(() => {});
    // Fallback: plain message (Discord ephemeral needs a command context; for
    // event-driven warnings a visible nudge is fine).
    else if (ch) await ch.send({ content: `@${user}: ${text}` }).catch(() => {});
  },
  async postMessage(channel, text) {
    const ch = client.channels.cache.get(channel);
    if (ch) await ch.send({ content: text }).catch(() => {});
  },
  async markCounted(channel, ts) {
    await api.addReaction(channel, ts, "✅");
    await api.removeReaction(channel, ts, "⚠️");
  },
  async getHistory(channel, limit) {
    const ch = client.channels.cache.get(channel);
    if (!ch) return [];
    const msgs = await ch.messages.fetch({ limit });
    // Normalize to the { user, ts (epoch-seconds-as-string), text, files } shape
    // that core expects, so /sniped works identically on both platforms.
    return [...msgs.values()].map((m) => ({
      user: m.author?.id,
      ts: (m.createdTimestamp / 1000).toFixed(2),
      text: m.content || "",
      files: (m.attachments || []).map((a) => ({ mimetype: a.contentType, url: a.url })),
    }));
  },
};

async function warnWithReason(channel, ts, user, reason) {
  await api.addReaction(channel, ts, "⚠️");
  await api.postEphemeral(
    channel,
    user,
    `Not counted yet: ${reason}\nFix it within ${Math.floor(core.PAIR_WINDOW_MS / 60000)} minutes and I will auto-pair it.`
  );
}

// discord.js renamed intent flags to PascalCase in newer 14.x (Guilds, not
// GUILDS). Pick whichever casing is present so any 14.x works.
function intentFlag(pascal, screaming) {
  return GatewayIntentBits[pascal] ?? GatewayIntentBits[screaming];
}

const client = Client ? new Client({
  intents: [
    intentFlag("Guilds", "GUILDS"),
    intentFlag("GuildMessages", "GUILD_MESSAGES"),
    intentFlag("MessageContent", "MESSAGE_CONTENT"),
    intentFlag("GuildMessageReactions", "GUILD_MESSAGE_REACTIONS"),
  ],
}) : null;

// ----- Message event (1 message or 2 messages in any order) -----
if (client) {
  client.on("messageCreate", (message) => {
    handleIncomingMessage(message).catch((err) => console.error("discord message handler error:", err));
  });
}

async function handleIncomingMessage(message) {
  if (!message.guild) return; // DMs not used
  const channel = message.channel.id;
  if (channel !== SNIPE_CHANNEL) return;
  if (message.author.bot) return;

  const sniper = message.author.id;

  const mentioned = core.extractMentionedUserIds(message.content || "").filter((u) => u !== sniper);
  const hasImg = discordHasImage(message);

  if (!hasImg && mentioned.length === 0) return;

  if (mentioned.length > 1) {
    await warnWithReason(channel, message.id, sniper, "mention exactly 1 target (only one @person).");
    return;
  }

  const target = mentioned.length === 1 ? mentioned[0] : null;

  // A) photo + target together
  if (hasImg && target) {
    await core.countSnipe({ api, channel, photoTs: message.id, sniper, target });
    return;
  }

  // B) photo only
  if (hasImg && !target) {
    await handlePhotoOnly({ channel, ts: message.id, sniper });
    return;
  }

  // C) target only
  if (!hasImg && target) {
    await handleTargetOnly({ channel, ts: message.id, sniper, target });
    return;
  }
}

const pendingPhotoByUser = new Map(); // userId -> { channel, ts }
const pendingTargetByUser = new Map(); // userId -> { channel, ts, target }

async function handlePhotoOnly({ channel, ts, sniper }) {
  pendingPhotoByUser.set(sniper, { channel, ts });

  const pendingT = pendingTargetByUser.get(sniper);
  if (pendingT && pendingT.channel === channel && core.isFresh(pendingT.ts)) {
    await core.countSnipe({ api, channel, photoTs: ts, sniper, target: pendingT.target });
    await api.removeReaction(channel, pendingT.ts, "⚠️");
    pendingPhotoByUser.delete(sniper);
    pendingTargetByUser.delete(sniper);
    return;
  }

  await warnWithReason(channel, ts, sniper, "missing @target. Send a message that mentions exactly 1 person.");
}

async function handleTargetOnly({ channel, ts, sniper, target }) {
  pendingTargetByUser.set(sniper, { channel, ts, target });

  const pendingP = pendingPhotoByUser.get(sniper);
  if (pendingP && pendingP.channel === channel && core.isFresh(pendingP.ts)) {
    await core.countSnipe({ api, channel, photoTs: pendingP.ts, sniper, target });
    await api.removeReaction(channel, ts, "⚠️");
    pendingPhotoByUser.delete(sniper);
    pendingTargetByUser.delete(sniper);
    return;
  }

  await warnWithReason(channel, ts, sniper, "missing photo. Upload a photo and I will auto-pair it.");
}

// ----- Reactions (caught sniping, target-only 👀) -----
if (client) {
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      if (user.bot) return;
      if (reaction.message.channel?.id !== SNIPE_CHANNEL) return;
      if (reaction.emoji.name !== "eyes") return;

      await core.updateDB((db) => {
        const k = core.keyFor(reaction.message.channel.id, reaction.message.id);
        const rec = db.snipes[k];
        if (!rec || !rec.valid) return;
        if (user.id !== rec.target) return;
        if (!rec.eyesBy.includes(user.id)) rec.eyesBy.push(user.id);
      });
    } catch (err) {
      console.error("discord reactionAdd error:", err);
    }
  });

  client.on("messageReactionRemove", async (reaction, user) => {
    try {
      if (user.bot) return;
      if (reaction.message.channel?.id !== SNIPE_CHANNEL) return;
      if (reaction.emoji.name !== "eyes") return;

      await core.updateDB((db) => {
        const k = core.keyFor(reaction.message.channel.id, reaction.message.id);
        const rec = db.snipes[k];
        if (!rec || !rec.valid) return;
        rec.eyesBy = rec.eyesBy.filter((u) => u !== user.id);
      });
    } catch (err) {
      console.error("discord reactionRemove error:", err);
    }
  });
}

// ----- Slash commands -----
function buildCommands() {
  return [
    new SlashCommandBuilder().setName("snipeboard").setDescription("Show the top snipers / most-sniped leaderboard"),
    new SlashCommandBuilder()
      .setName("snipestats")
      .setDescription("Your snipe stats")
      .addUserOption((o) => o.setName("user").setDescription("Whose stats")),
    new SlashCommandBuilder()
      .setName("sniped")
      .setDescription("Force-count your most recent photo")
      .addUserOption((o) => o.setName("user").setDescription("Who you sniped (optional — falls back to the @mention in the photo)")),
    new SlashCommandBuilder().setName("snipeseason").setDescription("Show the current term/season and when it resets"),
    new SlashCommandBuilder().setName("snipereset").setDescription("Reset the season (admins only)"),
  ];
}

if (client) {
  client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const channel = interaction.channel?.id;

  try {
    switch (interaction.commandName) {
      case "snipeboard": {
        const db = await core.loadDBForRead();
        const s = core.computeStats(db);
        await interaction.reply({
          content:
            `**Top Snipers**\n${s.topSnipers}\n\n` +
            `**Most Sniped**\n${s.mostSniped}\n\n` +
            `**Most Caught Sniping (👀 by target)**\n${s.mostCaughtSniping}`,
        });
        break;
      }

      case "snipestats": {
        const optUser = interaction.options.getUser("user");
        const who = optUser ? optUser.id : interaction.user.id;
        const db = await core.loadDBForRead();
        const snipes = Object.values(db.snipes).filter((r) => r.valid);
        const asSniper = snipes.filter((r) => r.sniper === who).length;
        const asTarget = snipes.filter((r) => r.target === who).length;
        const caughtSniping = snipes.filter((r) => r.sniper === who && (r.eyesBy?.length || 0) > 0).length;
        await interaction.reply({
          content:
            `**Stats for** <@${who}>\n` +
            `Snipes made: **${asSniper}**\n` +
            `Times sniped: **${asTarget}**\n` +
            `Caught sniping (👀 by target): **${caughtSniping}*`,
          allowedMentions: [who],
        });
        break;
      }

      case "sniped": {
        if (channel !== SNIPE_CHANNEL) {
          await interaction.reply({ content: "Use /sniped in the snipes channel only.", ephemeral: true });
          return;
        }
        const sniper = interaction.user.id;
        const optUser = interaction.options.getUser("user");
        let target = optUser ? optUser.id : null;

        const msgs = await api.getHistory(channel, 200);
        const imgMsg = msgs.find(
          (msg) =>
            msg.user === sniper &&
            discordHasImageFromNormalized(msg) &&
            Date.now() - core.tsToMs(msg.ts) <= core.SNIPED_MAX_AGE_MS
        );

        if (!imgMsg) {
          await interaction.reply({ content: "No recent photo found from you (last 60 minutes). Post the photo in this channel, then run /sniped.", ephemeral: true });
          return;
        }

        if (!target) {
          const mentioned = core.extractMentionedUserIds(imgMsg.text || "").filter((u) => u !== sniper);
          if (mentioned.length === 1) target = mentioned[0];
        }

        if (!target) {
          await interaction.reply({ content: "I could not figure out who you sniped. Use /sniped with a user or include exactly 1 @mention in the photo message.", ephemeral: true });
          return;
        }

        const inserted = await core.countSnipe({ api, channel, photoTs: imgMsg.ts, sniper, target, manual: true });
        await interaction.reply({ content: inserted ? "Counted ✅" : "That photo was already counted ✅", ephemeral: true });
        break;
      }

      case "snipeseason": {
        const db = await core.loadDBForRead();
        core.ensureSeasonFields(db);
        const cur = core.currentSeasonInfo(Date.now());
        const daysLeft = Math.max(0, Math.ceil((cur.endMs - Date.now()) / (24 * 60 * 60 * 1000)));
        await interaction.reply({
          content:
            `**${cur.name}** season (${cur.seasonId}) started: ${core.formatDate(db.seasonStartMs)}. ` +
            `Resets around ${core.formatDate(cur.endMs)} (about ${daysLeft} day(s)).`,
        });
        break;
      }

      case "snipereset": {
        if (!core.ADMIN_IDS.has(interaction.user.id)) {
          await interaction.reply({ content: "You are not allowed to reset the season.", ephemeral: true });
          return;
        }
        await core.updateDB((db) => {
          core.manualResetSameTerm(db);
        });
        await interaction.reply({ content: "Season reset ✅ (new leaderboard started)" });
        break;
      }
    }
  } catch (err) {
    console.error(`discord /${interaction.commandName} error:`, err);
    const reply = interaction.deferred || interaction.replied ? interaction.followUp : interaction.reply;
    await reply({ content: "Error while handling command. Check bot console.", ephemeral: true }).catch(() => {});
  }
});
}

function discordHasImage(message) {
  return (message.attachments?.size || 0) > 0 && [...message.attachments.values()].some((a) => (a.contentType || "").startsWith("image/"));
}

// Normalized {files:[{mimetype}]} from api.getHistory
function discordHasImageFromNormalized(msg) {
  if (!Array.isArray(msg.files)) return false;
  return msg.files.some((f) => typeof f.mimetype === "string" && f.mimetype.startsWith("image/"));
}

async function registerCommands() {
  const rest = new REST({ token: process.env.DISCORD_BOT_TOKEN });
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
    commands: buildCommands(),
  });
  console.log("Discord slash commands registered.");
}

module.exports = {
  available: !!Client,
  async start() {
    if (!Client) throw new Error("discord.js not installed. Run: npm i discord.js");
    await registerCommands();
    await client.login(process.env.DISCORD_BOT_TOKEN);
    client.once("ready", () => {
      console.log(`Discord running as ${client.user?.tag}. Channel:`, SNIPE_CHANNEL);
    });
    return client;
  },
  client,
};
