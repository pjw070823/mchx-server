import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { DOWNLOAD, LATEST, releaseInfo } from "../src/release.js";

/**
 * The jar is committed under `public/` and described in `release.ts`, and nothing
 * mechanically ties the two together — a release is a human copying a file and pasting a
 * hash. These check that they still agree.
 *
 * Getting it wrong is silent and total: the mod refuses a download whose hash does not
 * match, so a stale hash means every player is told to update and then cannot.
 */
describe("the published jar matches what the server advertises", () => {
  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

  it("has a download to offer", () => {
    // Null is legal in the type — it means "nothing published yet" — but once a jar has
    // been published, losing it should fail here rather than in front of a player.
    assert.ok(DOWNLOAD, "release.ts advertises no download");
  });

  it("serves the file it advertises, from a path under public/", () => {
    const path = new URL(DOWNLOAD!.url).pathname;
    assert.ok(path.startsWith("/downloads/"), `unexpected path ${path}`);
    // `express.static(public)` is what serves this, so the URL path is the file path.
    assert.ok(existsSync(publicDir + path.slice(1)), `no file at public${path}`);
  });

  it("advertises the real size and hash", () => {
    const file = publicDir + new URL(DOWNLOAD!.url).pathname.slice(1);
    assert.equal(statSync(file).size, DOWNLOAD!.sizeBytes, "sizeBytes is stale");

    const sha512 = createHash("sha512").update(readFileSync(file)).digest("hex");
    assert.equal(sha512, DOWNLOAD!.sha512, "sha512 is stale — the mod will refuse this file");
  });

  it("names the file after the version it claims to be", () => {
    // Not load-bearing, but a jar called 0.1.1 while LATEST says 0.2.0 is how a wrong
    // file gets shipped without anyone noticing.
    assert.ok(
      new URL(DOWNLOAD!.url).pathname.includes(LATEST),
      `${DOWNLOAD!.url} does not mention ${LATEST}`,
    );
  });

  it("never advertises a tester build", () => {
    // The tester jar sits next to the real one in build/libs with a name one glob away.
    // Publishing it would hand every player the cheat-enabled build.
    assert.ok(!DOWNLOAD!.url.includes("tester"), "the advertised jar is a tester build");
  });

  it("offers over HTTPS, since this installs code", () => {
    assert.equal(new URL(DOWNLOAD!.url).protocol, "https:");
  });

  it("reports the same thing through releaseInfo()", () => {
    assert.deepEqual(releaseInfo().download, DOWNLOAD);
    assert.equal(releaseInfo().version, LATEST);
  });
});
