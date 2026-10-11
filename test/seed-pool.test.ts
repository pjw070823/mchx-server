import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Sets MCHX_DB_PATH as a side effect, which is also where the pool file is looked for.
// Must come before the dynamic imports below.
import { boardOf, FAST, FakeWs, muteConsole, seat } from "./helpers.js";

const { parsePool, SeedPool, POOL_MINECRAFT } = await import("../src/seed-pool.js");
const { Room } = await import("../src/room.js");
const { withoutPoolSeed } = await import("../src/api-routes.js");

let restoreConsole: () => void;
before(() => { restoreConsole = muteConsole(); });
after(() => restoreConsole());

/** A pool line as `seedtool/run.py pool` writes it. */
function record(seed: string, found: string[], extra: Record<string, unknown> = {}): string {
  const tags: Record<string, unknown> = {};
  for (const name of ["village", "ruinedPortal", "lavaPool", "caveEntrance"]) {
    tags[name] = found.includes(name) ? { found: true, distance: 40, x: 1, y: 64, z: 2 } : { found: false };
  }
  return JSON.stringify({
    seedId: `s_${seed.replace("-", "n")}`, seed, mcVersion: POOL_MINECRAFT, rulesHash: "abcd1234",
    spawn: { x: 0, y: 64, z: 0 }, tags, categoryCount: found.length, status: "verified",
    usage: { count: 0, lastUsedAt: null }, createdAt: "2026-10-11T00:00:00Z", ...extra,
  });
}

describe("parsePool", () => {
  it("keeps a seed exactly, sign and low bits included", () => {
    // Both of these are past what a JSON number can hold. Read as one, the first comes
    // back as ...684000 — a different world, with no village in it.
    const [a, b] = parsePool([
      record("-6132191740934364683", ["village"]),
      record("9038922680165180570", ["caveEntrance"]),
    ].join("\n"));
    assert.equal(a!.seed, -6132191740934364683n);
    assert.equal(b!.seed, 9038922680165180570n);
  });

  it("lists what a seed has, in a fixed order", () => {
    const [seed] = parsePool(record("1", ["caveEntrance", "village"]));
    assert.deepEqual(seed!.features, ["village", "caveEntrance"]);
  });

  it("skips what should not be played on", () => {
    const seeds = parsePool([
      record("1", ["village"], { status: "retired" }),
      record("2", ["village"], { mcVersion: "26.1.2" }),   // judged in another Minecraft
      record("3", []),                                     // nothing near its spawn
      JSON.stringify({ seed: 4, mcVersion: POOL_MINECRAFT, status: "verified", tags: {} }),  // seed as a number
      "",
      record("5", ["lavaPool"]),
    ].join("\n"));
    assert.deepEqual(seeds.map((s) => s.seed), [5n]);
  });
});

describe("SeedPool", () => {
  const dir = mkdtempSync(join(tmpdir(), "mchx-pool-"));
  const path = join(dir, "seed-pool.jsonl");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("is empty, not broken, when there is no file", () => {
    const pool = new SeedPool(path);
    assert.equal(pool.size(), 0);
    assert.equal(pool.pick(), null);
  });

  it("draws from what the file holds", () => {
    writeFileSync(path, [record("11", ["village"]), record("22", ["lavaPool"])].join("\n"));
    const pool = new SeedPool(path);
    assert.equal(pool.size(), 2);
    const drawn = new Set<bigint>();
    for (let i = 0; i < 60; i++) drawn.add(pool.pick()!.seed);
    assert.deepEqual([...drawn].sort(), [11n, 22n], "both come up, and nothing else does");
  });

  it("picks up a new file without being restarted", () => {
    writeFileSync(path, record("11", ["village"]));
    const pool = new SeedPool(path);
    assert.equal(pool.size(), 1);

    writeFileSync(path, [record("33", ["village"]), record("44", ["village"]), record("55", ["village"])].join("\n"));
    // Same-millisecond writes would look unchanged; a real upload is seconds apart.
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    assert.equal(pool.size(), 3);
  });

  it("keeps the last good pool when the file is half written", () => {
    writeFileSync(path, record("11", ["village"]));
    utimesSync(path, new Date(), new Date(Date.now() + 10_000));
    const pool = new SeedPool(path);
    assert.equal(pool.size(), 1);

    writeFileSync(path, record("11", ["village"]) + "\n{\"seedId\": \"s_trunc");
    utimesSync(path, new Date(), new Date(Date.now() + 15_000));
    assert.equal(pool.size(), 1, "an upload in progress must not empty the pool");
  });
});

/**
 * The room's side. The room reads the process-wide pool, whose file sits beside the test
 * database — so these write that file and take it away again.
 */
describe("Room — seed filter", () => {
  const poolPath = join(dirname(process.env.MCHX_DB_PATH!), "seed-pool.jsonl");
  let stamp = Date.now() + 60_000;

  function givePool(lines: string[]) {
    writeFileSync(poolPath, lines.join("\n"));
    stamp += 5000;
    utimesSync(poolPath, new Date(), new Date(stamp));
  }
  after(() => rmSync(poolPath, { force: true }));

  function filteredRoom() {
    const room = new Room(FAST);
    const a = seat(room, "p1", "Alice");
    const b = seat(room, "p2", "Bob");
    assert.equal(room.updateSettings("p1", { seedFilter: true }), true);
    return { room, a, b };
  }

  it("is off unless the host turns it on, and then the seed is rolled as ever", () => {
    givePool([record("777", ["village"])]);
    const room = new Room(FAST);
    const a = seat(room, "p1", "Alice");
    seat(room, "p2", "Bob");
    room.startMatchByHost("p1");
    assert.notEqual(room.seed, 777n);
    assert.equal(a.sock.last("match_start")?.seedFeatures, null);
  });

  it("plays on a seed from the pool and says what it has — not where", () => {
    givePool([record("-6132191740934364683", ["village", "lavaPool"])]);
    const { room, a, b } = filteredRoom();
    assert.deepEqual(room.startMatchByHost("p1"), { ok: true });

    assert.equal(room.seed, -6132191740934364683n);
    const start = a.sock.last("match_start")!;
    assert.equal(start.seed, "-6132191740934364683", "and it reaches the client as a string, intact");
    assert.deepEqual(start.seedFeatures, ["village", "lavaPool"]);
    assert.deepEqual(b.sock.last("match_start")?.seedFeatures, ["village", "lavaPool"]);
    assert.equal(JSON.stringify(start).includes('"distance"'), false, "no coordinates leave the server");
  });

  it("refuses to start rather than quietly rolling a random seed", () => {
    rmSync(poolPath, { force: true });
    const { room, a } = filteredRoom();
    assert.deepEqual(room.startMatchByHost("p1"), { ok: false, reason: "seed_pool_empty" });
    assert.equal(room.status, "waiting");
    assert.equal(a.sock.all("match_start").length, 0);
  });

  it("deals a different board each time the same seed comes up", () => {
    // One seed in the pool, so every match is on it. Dealt from the seed, as a random
    // match's board is, all of these would be the same twenty-five missions.
    givePool([record("42", ["caveEntrance"])]);
    const { room, a } = filteredRoom();
    const boards = new Set<string>();
    for (let i = 0; i < 4; i++) {
      room.startMatchByHost("p1");
      assert.equal(room.seed, 42n);
      boards.add(JSON.stringify(boardOf(a.sock)));
      room.forfeitMatch("p1");
    }
    assert.ok(boards.size > 1, "the board must not be a function of a seed that repeats");
  });

  it("never touches a ranked room", () => {
    givePool([record("42", ["village"])]);
    const room = new Room(FAST, "ranked");
    const a = seat(room, "p1", "Alice");
    seat(room, "p2", "Bob");
    assert.equal(room.updateSettings("p1", { seedFilter: true }), false, "nobody sets a ranked room's settings");
    assert.equal(room.settings.seedFilter, false);
    room.start();
    assert.notEqual(room.seed, 42n);
    assert.equal(a.sock.last("match_start")?.seedFeatures, null);
  });

  it("tells a spectator what the seed has, and still not the seed", () => {
    givePool([record("42", ["ruinedPortal"])]);
    const { room } = filteredRoom();
    room.startMatchByHost("p1");
    const spec = new FakeWs();
    room.addSpectator(spec.ws);
    assert.equal(spec.last("match_start")?.seed, null);
    assert.deepEqual(spec.last("match_start")?.seedFeatures, ["ruinedPortal"]);
  });
});

describe("public match rows", () => {
  const row = (settings: object) => ({ id: 1, seed: "12345", settings_json: JSON.stringify(settings) });

  it("drop the seed of a match played on a pool seed", () => {
    assert.equal(withoutPoolSeed(row({ gameMode: "1v1", seedFilter: true })).seed, null);
  });

  it("keep the seed of a match whose seed was rolled", () => {
    assert.equal(withoutPoolSeed(row({ gameMode: "1v1", seedFilter: false })).seed, "12345");
    // Matches from before the setting existed.
    assert.equal(withoutPoolSeed(row({ gameMode: "1v1" })).seed, "12345");
    assert.equal(withoutPoolSeed({ id: 2, seed: "9", settings_json: null }).seed, "9");
  });

  it("leave the rest of the row alone", () => {
    const out = withoutPoolSeed(row({ seedFilter: true }));
    assert.equal(out.id, 1);
    assert.equal(out.settings_json, '{"seedFilter":true}');
  });
});
