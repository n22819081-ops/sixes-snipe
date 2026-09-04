# Snipe Bot

A photo-sniping bot for **Slack** and/or **Discord**. Post a photo and @-mention
one person (in either order, within 5 minutes) and it gets counted. A per-term
leaderboard tracks top snipers, most-sniped, and caught sniping (👀 by the target).

## How it's structured

```
index.js            launcher, starts whichever platform has its tokens (either/both)
core.js             the platform-agnostic brain (DB, seasons, stats, pairing)
platform/slack.js   @slack/bolt adapter
platform/discord.js discord.js adapter (optional dep)
test/core.test.js   core smoke test (no network needed)
```

The shared logic (leaderboard, pairing, seasons, stats) lives in `core.js` so
it isn't written twice. Each platform file is a thin wrapper that feeds its
own events into that shared core. The core doesn't know which platform it's on.
the wrapper hands it the platform's render function (reactions, messages,
history) and stays out of core's way.

## Setup

```bash
npm install
cp .env.example .env
# fill in .env (see below)
npm start
```

Node >= 18 (the floor @slack/bolt requires).

### .env

| Variable | Platform | Meaning |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | Slack | `xoxb-...` bot token |
| `SLACK_APP_TOKEN` | Slack | `xapp-...` app-level token (socket mode) |
| `SNIPE_CHANNEL_ID` | Slack | the channel ID where sniping happens |
| `DISCORD_BOT_TOKEN` | Discord | bot token |
| `DISCORD_CLIENT_ID` | Discord | application ID (for slash-command registration) |
| `DISCORD_SNIPE_CHANNEL_ID` | Discord | the channel ID where sniping happens |
| `SNIPE_ADMIN_IDS` | both | comma-separated user IDs allowed to `/snipereset` |
| `SNIPE_SPRING_START` / `SNIPE_SUMMER_START` / `SNIPE_FALL_START` | both | term boundaries, `MM-DD` (defaults shown in `.env.example`) |

The launcher starts **whichever platform has its tokens**. Set both token sets
and both run side by side (they use separate channel IDs). Leave a set empty and
that platform is skipped. No `BOT_PLATFORM` switch needed.

### Discord setup (greenfield)

1. Create an app at the [Discord Developer Portal](https://discord.com/developers/applications) → **Bot** → copy the token into `DISCORD_BOT_TOKEN`.
2. Enable **Privileged Gateway Intents**: turn on **Message Content**. Required: without it the bot can't read the message body, so photo+mention won't fire.
3. Invite the bot with scope `bot` and permissions: View Channels, Send Messages, Add Reactions, Read Message History.
4. Set `DISCORD_CLIENT_ID` (the application ID) and `DISCORD_SNIPE_CHANNEL_ID`.
5. `discord.js` is a dependency (`npm install` pulls it). Slash commands register automatically on startup.

### Slack setup

1. Create a Slack app; install to your workspace; put the bot token (`xoxb-`) in `SLACK_BOT_TOKEN` and the app-level token (`xapp-`) in `SLACK_APP_TOKEN`.
2. Set `SNIPE_CHANNEL_ID`.
3. Grant scopes: `chat:write`, `reactions:read`, `reactions:write`, `channels:history`, `users:read`.

## Commands

| Command | What it does |
| --- | --- |
| `/snipeboard` | Top snipers, most-sniped, most-caught leaderboard |
| `/snipestats [@user]` | Your (or someone's) snipes made / times sniped / caught |
| `/sniped [@user]` | Force-count your most recent photo (last 60 min) |
| `/snipeseason` | Current term and when it resets |
| `/snipereset` | Reset the season (admins only) |

On Discord these are slash commands (`/snipeboard`, etc.).

## Pairing rules

- Photo + @target can arrive in **either order** within **5 minutes**; the bot pairs them automatically and adds a ✅.
- A photo with no @target (or a @mention with no photo) gets a ⚠️ warning and a private nudge to fix it.
- If the target adds 👀 to the counted photo, that's a "caught sniping".
- Deleting the photo marks it invalid.
- Seasons auto-reset on term change (spring/summer/fall by MM-DD), archiving the prior leaderboard.

## Data

State lives in `snipes.json` (gitignored). Writes are atomic (temp file + rename), so a crash mid-write can't corrupt it. `snipes.example.json` is a sanitized template. Override the path with `SNIPE_DB_FILE`.

## Test

```bash
npm test
```

Runs the platform-agnostic core smoke test (DB round-trip, season math, mention parsing, stats, count/dedupe) with no network connection.
