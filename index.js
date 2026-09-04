// index.js — launcher. Starts whichever platform has its tokens configured:
//   - Slack:    SLACK_BOT_TOKEN + SLACK_APP_TOKEN
//   - Discord:  DISCORD_BOT_TOKEN (+ DISCORD_CLIENT_ID for slash-command registration)
// Set both sets and both run side by side (they use separate channel IDs).
// Neither set → exit with a clear message.
//
// Each platform is required lazily so an unconfigured platform isn't constructed.

require("dotenv").config();

const started = [];

// ---- Slack ----
const slackEnabled = Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
if (slackEnabled) {
  if (!process.env.SNIPE_CHANNEL_ID) {
    throw new Error("Slack is enabled but SNIPE_CHANNEL_ID is missing in .env");
  }
  const slack = require("./platform/slack");
  started.push(
    slack.start().catch((err) => console.error("Slack platform failed:", err))
  );
  console.log("Slack: starting.");
} else {
  console.log("Slack: no SLACK_BOT_TOKEN/SLACK_APP_TOKEN — skipped.");
}

// ---- Discord ----
const discordEnabled = Boolean(process.env.DISCORD_BOT_TOKEN);
if (discordEnabled) {
  if (!process.env.DISCORD_SNIPE_CHANNEL_ID) {
    throw new Error("Discord is enabled but DISCORD_SNIPE_CHANNEL_ID is missing in .env");
  }
  const discord = require("./platform/discord");
  if (!discord.available) {
    console.warn("Discord: token set but discord.js is not installed — skipped (npm i discord.js).");
  } else {
    started.push(
      discord.start().catch((err) => console.error("Discord platform failed:", err))
    );
    console.log("Discord: starting.");
  }
} else {
  console.log("Discord: no DISCORD_BOT_TOKEN — skipped.");
}

if (started.length === 0) {
  console.error("No platform enabled. Set SLACK_BOT_TOKEN+SLACK_APP_TOKEN and/or DISCORD_BOT_TOKEN.");
  process.exit(1);
}

console.log(`Starting ${started.length} platform(s).`);
// Keep the event loop alive; platforms stay connected via their sockets.
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
