import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareVersions, isComparable, isOnOldMinecraft, isOutdated, isTooOld,
  LATEST, MINECRAFT_FLOOR, MINIMUM,
} from "../src/release.js";

describe("compareVersions", () => {
  it("orders by numeric component, not lexically", () => {
    // "0.10.0" < "0.9.0" if you compare these as strings, which is the whole reason
    // this function exists rather than a `<`.
    assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
    assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
    assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  });

  it("treats missing components as zero", () => {
    assert.equal(compareVersions("0.2", "0.2.0"), 0);
    assert.equal(compareVersions("1", "1.0.0"), 0);
  });

  it("ignores build metadata, which names the Minecraft version and not the build", () => {
    assert.equal(compareVersions("0.2.0+mc26.1.2", "0.2.0"), 0);
    assert.ok(compareVersions("0.3.0+mc26.1.2", "0.2.0+mc26.1.2") > 0);
  });

  it("ignores a pre-release suffix rather than mis-ordering it", () => {
    assert.equal(compareVersions("0.2.0-rc1", "0.2.0"), 0);
  });

  it("is a usable comparator", () => {
    const sorted = ["0.10.0", "0.2.0", "0.1.1", "0.9.3"].sort(compareVersions);
    assert.deepEqual(sorted, ["0.1.1", "0.2.0", "0.9.3", "0.10.0"]);
  });
});

describe("isComparable", () => {
  it("accepts the shapes the mod actually reports", () => {
    assert.ok(isComparable("0.1.1"));
    assert.ok(isComparable("0.2.0+mc26.1.2"));
    assert.ok(isComparable("1"));
  });

  it("rejects what a gate cannot have an opinion about", () => {
    // These are the two real cases: Fabric metadata that could not be read, and the
    // dev bot. Both must fall through the gate rather than be refused by it.
    assert.equal(isComparable("unknown"), false);
    assert.equal(isComparable("dev-bot"), false);
    assert.equal(isComparable(null), false);
    assert.equal(isComparable(undefined), false);
    assert.equal(isComparable(""), false);
    assert.equal(isComparable("0..1"), false);
    assert.equal(isComparable("0.1.x"), false);
  });
});

describe("the version gates", () => {
  it("lets an unreadable version through both gates", () => {
    // The protocol gate still applies to these connections; this one has no opinion.
    for (const v of ["unknown", "dev-bot", null, undefined]) {
      assert.equal(isTooOld(v), false, `isTooOld(${String(v)})`);
      assert.equal(isOutdated(v), false, `isOutdated(${String(v)})`);
    }
  });

  it("refuses a build below the minimum", () => {
    assert.equal(isTooOld("0.0.1"), true);
    assert.equal(isTooOld(MINIMUM), false);
  });

  it("admits but flags a build between the minimum and the latest", () => {
    assert.equal(isOutdated("0.0.1"), true);
    assert.equal(isOutdated(LATEST), false);
  });

  it("does not flag a build newer than this server knows about", () => {
    // A developer running an unreleased jar should not be told to downgrade.
    assert.equal(isOutdated("99.0.0"), false);
    assert.equal(isTooOld("99.0.0"), false);
  });

  it("draws the Minecraft line where the first build for it is", () => {
    assert.equal(isOnOldMinecraft("0.1.15"), true);
    assert.equal(isOnOldMinecraft(MINECRAFT_FLOOR), false);
    assert.equal(isOnOldMinecraft("unknown"), false, "the dev bot and unreadable builds pass");
  });

  it("keeps MINECRAFT_FLOOR at or below LATEST", () => {
    // Above it, the build being shipped would be told to reinstall itself.
    assert.ok(
      compareVersions(MINECRAFT_FLOOR, LATEST) <= 0,
      `MINECRAFT_FLOOR ${MINECRAFT_FLOOR} > LATEST ${LATEST}`,
    );
  });

  it("keeps MINIMUM at or below LATEST", () => {
    // Reversing these would refuse every client including the one being shipped, and
    // the mistake is a one-character edit away.
    assert.ok(compareVersions(MINIMUM, LATEST) <= 0, `MINIMUM ${MINIMUM} > LATEST ${LATEST}`);
  });
});
