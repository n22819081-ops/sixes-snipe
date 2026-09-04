// dry-run/discord.dry.js — dry run of the REAL discord.js adapter with no live
// server: builds a real Client, fires synthetic messageCreate events through the
// real handler, and verifies the snipe lands in a temp DB. No network needed.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const tmpDB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "snipe-discord-dry-")), "snipes.json");
process.env.SNIPE_DB_FILE = tmpDB;
process.env.DISCORD_BOT_TOKEN = "dummy-token-for-dry-run";
process.env.DISCORD_CLIENT_ID = "111222333";
process.env.DISCORD_SNIPE_CHANNEL_ID = "1000000000000000001";
process.env.SNIPE_ADMIN_IDS = "UADMIN1";

const { client } = require("../platform/discord");
assert.ok(client, "discord client should construct");

const CHANNEL = process.env.DISCORD_SNIPE_CHANNEL_ID;
const SNIPER = "9000000000000000001";
const TARGET = "9000000000000000002";

function freshId() {
  return (Date.now() / 1000).toFixed(2);
}

// Synthetic discord message shape the handler reads.
function fakeMessage({ id, content, withImage }) {
  const attachments = new Map();
  if (withImage) attachments.set("a1", { id: "att1", contentType: "image/png", url: "https://x/y.png", name: "y.png" });
  return {
    id,
    guild: { id: "guild1" },
    channel: { id: CHANNEL },
    author: { id: SNIPER, bot: false },
    content: content || "",
    attachments,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  console.log("Discord adapter dry run (real client, synthetic events)\n");
  let passed = 0;
  const ok = (n) => { passed++; console.log(`  ok  ${n}`); };

  // A) photo + target in ONE message -> counted directly
  const a1 = freshId();
  client.emit("messageCreate", fakeMessage({ id: a1, content: `snipe <@${TARGET}>`, withImage: true }));
  await sleep(50);
  let db = JSON.parse(fs.existsSync(tmpDB) ? fs.readFileSync(tmpDB, "utf8") : "{}");
  let rec = (db.snipes || {})[`${CHANNEL}|${a1}`];
  assert.ok(rec, "photo+target message should be counted");
  assert.strictEqual(rec.sniper, SNIPER);
  assert.strictEqual(rec.target, TARGET);
  ok("photo + @target in one message -> counted");

  // B) photo-only, then target-only (either order) -> auto-paired
  const bPhoto = freshId();
  const bTarget = freshId();
  client.emit("messageCreate", fakeMessage({ id: bPhoto, content: "", withImage: true }));
  await sleep(30);
  client.emit("messageCreate", fakeMessage({ id: bTarget, content: `@ <@${TARGET}>` }));
  await sleep(50);
  db = JSON.parse(fs.readFileSync(tmpDB, "utf8"));
  rec = (db.snipes || {})[`${CHANNEL}|${bPhoto}`];
  assert.ok(rec, "photo-only + target-only should be auto-paired (keyed on the photo ts)");
  assert.strictEqual(rec.target, TARGET);
  ok("photo-only then target-only -> auto-paired");

  // C) irrelevant channel -> ignored
  const cId = freshId();
  client.emit("messageCreate", {
    id: cId,
    guild: { id: "guild1" },
    channel: { id: "9999999999999999999" },
    author: { id: SNIPER, bot: false },
    content: `x <@${TARGET}>`,
    attachments: new Map([["a", { contentType: "image/png" }]]),
  });
  await sleep(30);
  db = JSON.parse(fs.readFileSync(tmpDB, "utf8"));
  assert.ok(!(db.snipes || {})[`9999999999999999999|${cId}`], "other channel should be ignored");
  ok("other channel -> ignored");

  // D) no image + no mention -> ignored (no write)
  const before = Object.keys(JSON.parse(fs.readFileSync(tmpDB, "utf8")).snipes).length;
  const dId = freshId();
  client.emit("messageCreate", fakeMessage({ id: dId, content: "just a text post", withImage: false }));
  await sleep(30);
  const after = Object.keys(JSON.parse(fs.readFileSync(tmpDB, "utf8")).snipes).length;
  assert.strictEqual(after, before, "text-only message should not be counted");
  ok("text-only message -> ignored");

  console.log(`\n${passed} passed`);
  fs.unlinkSync(tmpDB);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
