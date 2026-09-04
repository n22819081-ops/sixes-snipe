// core.js — the platform-agnostic brain of the snipe bot.
// Season logic, DB IO (atomic), stats, and pairing rules live here.
// A platform adapter (platform/slack.js, platform/discord.js) injects an
// "api" object to render reactions/messages and does the message parsing.

const fs = require("fs/promises");

// DB_FILE is overridable via SNIPE_DB_FILE so tests don't clobber the real DB.
const DB_FILE = process.env.SNIPE_DB_FILE || "snipes.json";
const SNIPE_CHANNEL_ID = process.env.SNIPE_CHANNEL_ID;

// ----- Admins (for /snipereset) -----
const ADMIN_IDS = new Set(
  (process.env.SNIPE_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// ----- Term Seasons (Spring/Summer/Fall by MM-DD) -----
const SPRING_START_MMDD = process.env.SNIPE_SPRING_START || "01-12";
const SUMMER_START_MMDD = process.env.SNIPE_SUMMER_START || "05-11";
const FALL_START_MMDD = process.env.SNIPE_FALL_START || "08-20";

function parseMMDD(mmdd) {
  const m = /^(\d{2})-(\d{2})$/.exec(mmdd);
  if (!m) throw new Error(`Bad MM-DD: ${mmdd}`);
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Bad month in MM-DD: ${mmdd}`);
  if (day < 1 || day > 31) throw new Error(`Bad day in MM-DD: ${mmdd}`);
  return { month, day };
}

function boundaryMs(year, mmdd) {
  const { month, day } = parseMMDD(mmdd);
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

function currentSeasonInfo(nowMs) {
  const now = new Date(nowMs);
  const y = now.getFullYear();

  const springStart = boundaryMs(y, SPRING_START_MMDD);
  const summerStart = boundaryMs(y, SUMMER_START_MMDD);
  const fallStart = boundaryMs(y, FALL_START_MMDD);

  const nextSpringStart = boundaryMs(y + 1, SPRING_START_MMDD);
  const prevFallStart = boundaryMs(y - 1, FALL_START_MMDD);

  if (nowMs >= fallStart) return { seasonId: `${y}-fall`, name: "Fall", startMs: fallStart, endMs: nextSpringStart };
  if (nowMs >= summerStart) return { seasonId: `${y}-summer`, name: "Summer", startMs: summerStart, endMs: fallStart };
  if (nowMs >= springStart) return { seasonId: `${y}-spring`, name: "Spring", startMs: springStart, endMs: summerStart };

  return { seasonId: `${y - 1}-fall`, name: "Fall", startMs: prevFallStart, endMs: springStart };
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString();
}

// ----- DB IO (atomic: write temp then rename) -----
function emptyDB() {
  return { snipes: {}, archives: [], seasonId: null, seasonStartMs: null };
}

async function loadDB() {
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    // Warn instead of silently wiping — a corrupt file should be noticed.
    if (err.code !== "ENOENT") console.warn("DB unreadable, resetting:", err.message);
    return emptyDB();
  }
}

async function saveDB(db) {
  const tmp = DB_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(tmp, DB_FILE); // atomic — a crash never leaves half-JSON
}

function keyFor(channel, ts) {
  return `${channel}|${ts}`;
}

// ----- Queue DB writes (no clobber) -----
let dbQueue = Promise.resolve();

function queueDB(task) {
  const next = dbQueue.then(task);
  dbQueue = next.catch((err) => console.error("DB error:", err));
  return next;
}

// ----- Stats + Season logic -----
function computeStats(db) {
  const snipes = Object.values(db.snipes || {}).filter((r) => r.valid);

  const sniperCount = new Map();
  const targetCount = new Map();
  const caughtSnipingCount = new Map();

  for (const r of snipes) {
    sniperCount.set(r.sniper, (sniperCount.get(r.sniper) || 0) + 1);
    targetCount.set(r.target, (targetCount.get(r.target) || 0) + 1);
    const caught = (r.eyesBy?.length || 0) > 0 ? 1 : 0;
    caughtSnipingCount.set(r.sniper, (caughtSnipingCount.get(r.sniper) || 0) + caught);
  }

  const top = (m) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, n], i) => `${i + 1}. ${formatMention(id)}: ${n}`)
      .join("\n") || "No data yet.";

  return {
    topSnipers: top(sniperCount),
    mostSniped: top(targetCount),
    mostCaughtSniping: top(caughtSnipingCount),
  };
}

// formatMention is injected by the adapter (Slack: <@ID>, Discord: <@ID>).
let formatMentionFn = (id) => id;
function formatMention(id) {
  return formatMentionFn(id);
}

function ensureSeasonFields(db) {
  if (!Array.isArray(db.archives)) db.archives = [];
  if (!db.snipes || typeof db.snipes !== "object") db.snipes = {};

  const cur = currentSeasonInfo(Date.now());
  if (typeof db.seasonId !== "string" || !db.seasonId) db.seasonId = cur.seasonId;
  if (typeof db.seasonStartMs !== "number" || !db.seasonStartMs) db.seasonStartMs = cur.startMs;
}

function archiveSnapshot(db, reason) {
  const s = computeStats(db);
  db.archives.push({
    seasonId: db.seasonId,
    seasonStartMs: db.seasonStartMs,
    seasonEndMs: Date.now(),
    reason,
    snapshot: {
      topSnipers: s.topSnipers,
      mostSniped: s.mostSniped,
      mostCaughtSniping: s.mostCaughtSniping,
      totalSnipes: Object.values(db.snipes).filter((r) => r.valid).length,
    },
  });
}

function autoResetIfTermChanged(db) {
  ensureSeasonFields(db);
  const cur = currentSeasonInfo(Date.now());
  if (db.seasonId !== cur.seasonId) {
    archiveSnapshot(db, "auto-term-change");
    db.snipes = {};
    db.seasonId = cur.seasonId;
    db.seasonStartMs = cur.startMs;
    return true;
  }
  return false;
}

function manualResetSameTerm(db) {
  ensureSeasonFields(db);
  archiveSnapshot(db, "manual");
  db.snipes = {};
  // keep same seasonId, but restart seasonStartMs to now (new leaderboard)
  db.seasonStartMs = Date.now();
}

// ----- Pairing Rules (any order) -----
const PAIR_WINDOW_MS = 5 * 60 * 1000; // photo + target can be in either order within 5 min
const SNIPED_MAX_AGE_MS = 60 * 60 * 1000; // /sniped looks back 60 min for newest photo

const pendingPhotoByUser = new Map(); // userId -> { channel, ts }
const pendingTargetByUser = new Map(); // userId -> { channel, ts, target }

function clearInMemoryPairing() {
  pendingPhotoByUser.clear();
  pendingTargetByUser.clear();
}

function tsToMs(ts) {
  return Math.floor(parseFloat(ts) * 1000);
}

function isFresh(ts) {
  return Date.now() - tsToMs(ts) <= PAIR_WINDOW_MS;
}

// ----- UpdateDB and ReadDB (with auto reset) -----
async function updateDB(mutator) {
  return queueDB(async () => {
    const db = await loadDB();
    const didReset = autoResetIfTermChanged(db);
    if (didReset) clearInMemoryPairing();
    const result = await mutator(db);
    await saveDB(db);
    return result;
  });
}

// Reads run through the SAME queue as writes, so a read can't interleave with
// an in-flight write and clobber it. Persists only if a term change happened
// (the once-per-term archive must be saved somewhere).
async function loadDBForRead() {
  return queueDB(async () => {
    const db = await loadDB();
    const didReset = autoResetIfTermChanged(db);
    if (didReset) clearInMemoryPairing();
    if (didReset) await saveDB(db);
    return db;
  });
}

// ----- Parsing helpers -----
// extractMentionedUserIds works on Slack's <@ID> form and Discord's <@ID> form
// (both use <@ID>, so one regex covers both).
function extractMentionedUserIds(text = "") {
  const matches = text.match(/<@([A-Z0-9]+)(?:\|[^>]+)?/g) || [];
  return matches.map((m) => m.replace(/^<@/, "").replace(/>$/, "").split("|")[0]);
}

// ----- countSnipe: core + injected render api -----
async function countSnipe({ api, channel, photoTs, sniper, target, manual = false }) {
  const inserted = await updateDB((db) => {
    ensureSeasonFields(db);
    const k = keyFor(channel, photoTs);
    if (db.snipes[k]) return false;

    db.snipes[k] = {
      channel,
      ts: photoTs,
      sniper,
      target,
      valid: true,
      eyesBy: [],
      createdAt: Date.now(),
      manual,
    };
    return true;
  });

  await api.markCounted(channel, photoTs);

  if (inserted) {
    await api.postMessage(channel, `✅ ${formatMention(sniper)} sniped ${formatMention(target)}`);
  }

  return inserted;
}

module.exports = {
  DB_FILE,
  SNIPE_CHANNEL_ID,
  ADMIN_IDS,
  SPRING_START_MMDD,
  SUMMER_START_MMDD,
  FALL_START_MMDD,
  parseMMDD,
  boundaryMs,
  currentSeasonInfo,
  formatDate,
  loadDB,
  saveDB,
  keyFor,
  queueDB,
  computeStats,
  ensureSeasonFields,
  archiveSnapshot,
  autoResetIfTermChanged,
  manualResetSameTerm,
  clearInMemoryPairing,
  tsToMs,
  isFresh,
  updateDB,
  loadDBForRead,
  extractMentionedUserIds,
  countSnipe,
  setFormatMention: (fn) => (formatMentionFn = fn),
  PAIR_WINDOW_MS,
  SNIPED_MAX_AGE_MS,
};
