import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_MISSIONS, MISSIONS_BY_DIFFICULTY, getMission } from "../src/missions.js";
import { BOARD_SIZE } from "../src/hex.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Canonical copy, tracked in the parent repo alongside the mod. */
const SHARED = resolve(__dirname, "../../shared/missions.json");
/** Deployment copy, tracked in this repo so a standalone clone can boot. */
const LOCAL = resolve(__dirname, "../missions.json");

describe("mission catalogue", () => {
  it("has enough missions to fill every board slot", () => {
    assert.ok(MISSIONS_BY_DIFFICULTY.easy.length >= 12);
    assert.ok(MISSIONS_BY_DIFFICULTY.medium.length >= 8);
    assert.ok(MISSIONS_BY_DIFFICULTY.hard.length >= 5);
    assert.ok(ALL_MISSIONS.length >= BOARD_SIZE * BOARD_SIZE);
  });

  it("has unique ids", () => {
    const ids = new Set(ALL_MISSIONS.map((m) => m.id));
    assert.equal(ids.size, ALL_MISSIONS.length);
  });

  it("looks up by id", () => {
    const first = ALL_MISSIONS[0]!;
    assert.equal(getMission(first.id)?.id, first.id);
    assert.equal(getMission("no_such_mission"), undefined);
  });

  it("gives every mission a display name", () => {
    for (const m of ALL_MISSIONS) {
      assert.ok(m.displayName.trim().length > 0, `${m.id} has no displayName`);
    }
  });

  /**
   * The catalogue exists twice because the server is a separate repository: `shared/`
   * is where it is edited (the mod's detectors are written against it), and
   * `server/missions.json` is what ships when only this repo is deployed.
   *
   * They must not drift. A board built from one and detected against the other means
   * missions that can never complete. `npm run sync-missions` copies the canonical file
   * over; this test is what tells you that you forgot.
   */
  it("keeps the deployment copy identical to the canonical one", (t) => {
    if (!existsSync(SHARED)) {
      return t.skip("shared/missions.json not present — standalone server checkout");
    }
    assert.equal(
      readFileSync(LOCAL, "utf-8"),
      readFileSync(SHARED, "utf-8"),
      "server/missions.json has drifted from shared/missions.json — run `npm run sync-missions`",
    );
  });
});
