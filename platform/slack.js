// platform/slack.js — thin @slack/bolt adapter. Maps bolt events/reactions/
// commands onto the platform-agnostic core. Does NOT own the business logic.
const { App } = require("@slack/bolt");
const core = require("../core");

// Slack owns its channel. Discord uses DISCORD_SNIPE_CHANNEL_ID (see discord.js),
// so the two platforms can run side by side with different channels.
const SNIPE_CHANNEL = process.env.SNIPE_CHANNEL_ID;

// Slack renders mentions as <@ID>.
core.setFormatMention((id) => `<@${id}>`);

// Injected render API — what core needs to touch the platform.
const api = {
  async addReaction(channel, ts, name) {
    await app.client.reactions.add({ channel, timestamp: ts, name }).catch(() => {});
  },
  async removeReaction(channel, ts, name) {
    await app.client.reactions.remove({ channel, timestamp: ts, name }).catch(() => {});
  },
  async postEphemeral(channel, user, text) {
    await app.client.chat.postEphemeral({ channel, user, text }).catch(() => {});
  },
  async postMessage(channel, text) {
    await app.client.chat.postMessage({ channel, text }).catch(() => {});
  },
  async markCounted(channel, ts) {
    await api.addReaction(channel, ts, "white_check_mark");
    await api.removeReaction(channel, ts, "warning");
  },
  async getHistory(channel, limit) {
    const hist = await app.client.conversations.history({ channel, limit });
    return hist.messages || [];
  },
};

async function warnWithReason(channel, ts, user, reason) {
  await api.addReaction(channel, ts, "warning");
  await api.postEphemeral(
    channel,
    user,
    `Not counted yet: ${reason}\nFix it within ${Math.floor(core.PAIR_WINDOW_MS / 60000)} minutes and I will auto-pair it.`
  );
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// ----- Message event (1 message or 2 messages in any order) -----
app.event("message", async ({ event, client }) => {
  try {
    if (event.channel !== SNIPE_CHANNEL) return;

    // deletion
    if (event.subtype === "message_deleted" && event.previous_message?.ts) {
      const delTs = event.previous_message.ts;
      await core.updateDB((db) => {
        const k = core.keyFor(event.channel, delTs);
        if (db.snipes[k]) db.snipes[k].valid = false;
      });
      return;
    }

    // allow photo messages
    if (event.subtype && event.subtype !== "file_share") return;
    if (!event.user) return;

    const sniper = event.user;
    const channel = event.channel;

    const mentioned = core.extractMentionedUserIds(event.text || "").filter((u) => u !== sniper);
    const hasImg = slackHasImage(event.files);

    if (!hasImg && mentioned.length === 0) return;

    if (mentioned.length > 1) {
      await warnWithReason(channel, event.ts, sniper, "mention exactly 1 target (only one @person).");
      return;
    }

    const target = mentioned.length === 1 ? mentioned[0] : null;

    // A) photo + target together
    if (hasImg && target) {
      await core.countSnipe({ api, channel, photoTs: event.ts, sniper, target });
      return;
    }

    // B) photo only
    if (hasImg && !target) {
      await handlePhotoOnly({ api, sniper, channel, ts: event.ts });
      return;
    }

    // C) target only
    if (!hasImg && target) {
      await handleTargetOnly({ api, sniper, channel, ts: event.ts, target });
      return;
    }
  } catch (err) {
    console.error("slack message handler error:", err);
  }
});

// Pairing state lives in the adapter (platform-scoped), shared via core's maps
// is not needed — keep it here per-platform.
const pendingPhotoByUser = new Map();
const pendingTargetByUser = new Map();

async function handlePhotoOnly({ api, sniper, channel, ts }) {
  pendingPhotoByUser.set(sniper, { channel, ts });

  const pendingT = pendingTargetByUser.get(sniper);
  if (pendingT && pendingT.channel === channel && core.isFresh(pendingT.ts)) {
    await core.countSnipe({ api, channel, photoTs: ts, sniper, target: pendingT.target });
    await api.removeReaction(channel, pendingT.ts, "warning");
    pendingPhotoByUser.delete(sniper);
    pendingTargetByUser.delete(sniper);
    return;
  }

  await warnWithReason(channel, ts, sniper, "missing @target. Send a message that mentions exactly 1 person.");
}

async function handleTargetOnly({ api, sniper, channel, ts, target }) {
  pendingTargetByUser.set(sniper, { channel, ts, target });

  const pendingP = pendingPhotoByUser.get(sniper);
  if (pendingP && pendingP.channel === channel && core.isFresh(pendingP.ts)) {
    await core.countSnipe({ api, channel, photoTs: pendingP.ts, sniper, target });
    await api.removeReaction(channel, ts, "warning");
    pendingPhotoByUser.delete(sniper);
    pendingTargetByUser.delete(sniper);
    return;
  }

  await warnWithReason(channel, ts, sniper, "missing photo. Upload a photo and I will auto-pair it.");
}

// ----- Reactions (caught sniping, target-only 👀) -----
app.event("reaction_added", async ({ event }) => {
  try {
    if (event.item?.type !== "message") return;
    if (event.item.channel !== SNIPE_CHANNEL) return;
    if (event.reaction !== "eyes") return;

    await core.updateDB((db) => {
      const k = core.keyFor(event.item.channel, event.item.ts);
      const rec = db.snipes[k];
      if (!rec || !rec.valid) return;
      if (event.user !== rec.target) return;
      if (!rec.eyesBy.includes(event.user)) rec.eyesBy.push(event.user);
    });
  } catch (err) {
    console.error("slack reaction_added error:", err);
  }
});

app.event("reaction_removed", async ({ event }) => {
  try {
    if (event.item?.type !== "message") return;
    if (event.item.channel !== SNIPE_CHANNEL) return;
    if (event.reaction !== "eyes") return;

    await core.updateDB((db) => {
      const k = core.keyFor(event.item.channel, event.item.ts);
      const rec = db.snipes[k];
      if (!rec || !rec.valid) return;
      rec.eyesBy = rec.eyesBy.filter((u) => u !== event.user);
    });
  } catch (err) {
    console.error("slack reaction_removed error:", err);
  }
});

// ----- Slash commands -----
app.command("/snipeboard", async ({ ack, respond }) => {
  try {
    await ack();
    const db = await core.loadDBForRead();
    const s = core.computeStats(db);
    await respond({
      response_type: "in_channel",
      text:
        `*Top Snipers*\n${s.topSnipers}\n\n` +
        `*Most Sniped*\n${s.mostSniped}\n\n` +
        `*Most Caught Sniping (👀 by target)*\n${s.mostCaughtSniping}`,
    });
  } catch (err) {
    console.error("/snipeboard error:", err);
  }
});

app.command("/snipestats", async ({ command, ack, respond }) => {
  try {
    await ack();
    const text = (command.text || "").trim();
    const m = text.match(/<@([A-Z0-9]+)(?:\|[^>]+)?/);
    const who = m ? m[1] : command.user_id;

    const db = await core.loadDBForRead();
    const snipes = Object.values(db.snipes).filter((r) => r.valid);
    const asSniper = snipes.filter((r) => r.sniper === who).length;
    const asTarget = snipes.filter((r) => r.target === who).length;
    const caughtSniping = snipes.filter((r) => r.sniper === who && (r.eyesBy?.length || 0) > 0).length;

    await respond({
      response_type: "in_channel",
      text:
        `*Stats for* <@${who}>\n` +
        `Snipes made: *${asSniper}*\n` +
        `Times sniped: *${asTarget}*\n` +
        `Caught sniping (👀 by target): *${caughtSniping}*`,
    });
  } catch (err) {
    console.error("/snipestats error:", err);
  }
});

// /sniped [@user] -> force-count newest photo; if @user omitted, use mention in photo text
app.command("/sniped", async ({ command, ack, respond }) => {
  await ack();
  try {
    if (command.channel_id !== SNIPE_CHANNEL) {
      await respond({ response_type: "ephemeral", text: "Use /sniped in the snipes channel only." });
      return;
    }

    const sniper = command.user_id;
    const cmdText = (command.text || "").trim();
    const cmdMention = cmdText.match(/<@([A-Z0-9]+)(?:\|[^>]+)?/);
    const targetFromCmd = cmdMention ? cmdMention[1] : null;

    const msgs = await api.getHistory(command.channel_id, 200);
    const imgMsg = msgs.find(
      (msg) =>
        msg.user === sniper &&
        slackHasImage(msg.files) &&
        Date.now() - core.tsToMs(msg.ts) <= core.SNIPED_MAX_AGE_MS
    );

    if (!imgMsg) {
      await respond({
        response_type: "ephemeral",
        text: "No recent photo found from you (last 60 minutes). Post the photo in this channel (not a thread), then run /sniped.",
      });
      return;
    }

    let target = targetFromCmd;
    if (!target) {
      const mentioned = core.extractMentionedUserIds(imgMsg.text || "").filter((u) => u !== sniper);
      if (mentioned.length === 1) target = mentioned[0];
    }

    if (!target) {
      await respond({
        response_type: "ephemeral",
        text: "I could not figure out who you sniped. Use /sniped @user or include exactly 1 @mention in the photo message.",
      });
      return;
    }

    const inserted = await core.countSnipe({ api, channel: command.channel_id, photoTs: imgMsg.ts, sniper, target, manual: true });
    await respond({
      response_type: "ephemeral",
      text: inserted ? "Counted ✅" : "That photo was already counted ✅",
    });
  } catch (err) {
    console.error("/sniped error:", err);
    await respond({ response_type: "ephemeral", text: "Error while recording snipe. Check bot console + scopes." }).catch(() => {});
  }
});

app.command("/snipeseason", async ({ ack, respond }) => {
  try {
    await ack();
    const db = await core.loadDBForRead();
    core.ensureSeasonFields(db);

    const cur = core.currentSeasonInfo(Date.now());
    const daysLeft = Math.max(0, Math.ceil((cur.endMs - Date.now()) / (24 * 60 * 60 * 1000)));

    await respond({
      response_type: "in_channel",
      text:
        `*${cur.name}* season (${cur.seasonId}) started: ${core.formatDate(db.seasonStartMs)}. ` +
        `Resets around ${core.formatDate(cur.endMs)} (about ${daysLeft} day(s)).`,
    });
  } catch (err) {
    console.error("/snipeseason error:", err);
  }
});

app.command("/snipereset", async ({ command, ack, respond }) => {
  try {
    await ack();
    if (!core.ADMIN_IDS.has(command.user_id)) {
      await respond({ response_type: "ephemeral", text: "You are not allowed to reset the season." });
      return;
    }

    await core.updateDB((db) => {
      core.manualResetSameTerm(db);
    });

    await respond({
      response_type: "in_channel",
      text: "Season reset ✅ (new leaderboard started)",
    });
  } catch (err) {
    console.error("/snipereset error:", err);
  }
});

function slackHasImage(files) {
  if (!Array.isArray(files)) return false;
  return files.some((f) => {
    if (typeof f.mimetype === "string" && f.mimetype.startsWith("image/")) return true;
    const ft = (f.filetype || "").toLowerCase();
    return ["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(ft);
  });
}

module.exports = {
  start: () =>
    app.start().then(() => {
      console.log("Slack running. Channel:", SNIPE_CHANNEL);
    }),
  app,
};
