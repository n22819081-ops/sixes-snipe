// test/core.test.js — platform-agnostic smoke test for core.js.
// Runs without a network connection: exercises DB IO (atomic), season math,
// mention parsing, stats, and the full countSnipe path with a stub api.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

// Point the DB at a throwaway file BEFORE requiring core (it reads env at load).
const tmpDB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "snipe-test-")), "snipes.json");
process.env.SNIPE_DB_FILE = tmpDB;
process.env.SNIPE_ADMIN_IDS = "UADMIN1";

const core = require("../core");

let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn())
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((e) => {
      console.error(`  FAIL ${name}:`, e.message);
      process.exitCode = 1;
    });
}

(async () => {
  console.log("core.js smoke test\n");

  await test("keyFor formats channel|ts", () => {
    assert.strictEqual(core.keyFor("C1", "123.45"), "C1|123.45");
  });

  await test("tsToMs converts slack-style ts", () => {
    assert.strictEqual(core.tsToMs("1700000000.5"), 1700000000500);
  });

  await test("extractMentionedUserIds pulls IDs (slack + discord forms)", () => {
    assert.deepStrictEqual(
      core.extractMentionedUserIds("hi <@U1234> and <@U5678|bob>"),
      ["U1234", "U5678"]
    );
    assert.deepStrictEqual(core.extractMentionedUserIds("no mentions"), []);
  });

  await test("currentSeasonInfo returns a valid season", () => {
    const info = core.currentSeasonInfo(Date.now());
    assert.ok(info.seasonId.length > 0);
    assert.ok(info.startMs > 0 && info.endMs > info.startMs);
  });

  await test("loadDB returns empty shape when file missing", async () => {
    const db = await core.loadDB();
    assert.deepStrictEqual(db, { snipes: {}, archives: [], seasonId: null, seasonStartMs: null });
  });

  await test("saveDB + loadDB round-trip (atomic)", async () => {
    const db = { snipes: { k1: { channel: "C", ts: "1", sniper: "A", target: "B", valid: true, eyesBy: [] } }, archives: [], seasonId: "2026-fall", seasonStartMs: 123 };
    await core.saveDB(db);
    const loaded = await core.loadDB();
    assert.strictEqual(loaded.snipes.k1.target, "B");
    // temp file is renamed away, not left behind
    assert.strictEqual(fs.existsSync(tmpDB + ".tmp"), false);
  });

  await test("updateDB persists a write", async () => {
    await core.updateDB((db) => {
      db.snipes["C|2"] = { channel: "C", ts: "2", sniper: "X", target: "Y", valid: true, eyesBy: [], createdAt: Date.now() };
    });
    const db = await core.loadDB();
    assert.ok(db.snipes["C|2"]);
  });

  await test("computeStats ranks snipers and targets", async () => {
    const db = await core.loadDB();
    const s = core.computeStats(db);
    assert.ok(typeof s.topSnipers === "string");
    assert.ok(s.topSnipers.length > 0);
  });

  await test("countSnipe records a snipe + marks counted via api", async () => {
    let marked = 0;
    let posted = 0;
    const api = {
      markCounted: async () => { marked++; },
      postMessage: async () => { posted++; },
      addReaction: async () => {},
      removeReaction: async () => {},
    };
    const inserted = await core.countSnipe({ api, channel: "C", photoTs: "99", sniper: "SN", target: "TG" });
    assert.strictEqual(inserted, true);
    assert.strictEqual(marked, 1);
    assert.strictEqual(posted, 1);
    const db = await core.loadDB();
    assert.strictEqual(db.snipes["C|99"].sniper, "SN");
    assert.strictEqual(db.snipes["C|99"].target, "TG");
  });

  await test("countSnipe dedupes same photo", async () => {
    const api = { markCounted: async () => {}, postMessage: async () => {}, addReaction: async () => {}, removeReaction: async () => {} };
    const again = await core.countSnipe({ api, channel: "C", photoTs: "99", sniper: "SN", target: "TG" });
    assert.strictEqual(again, false);
  });

  console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
  fs.unlinkSync(tmpDB);
})();
