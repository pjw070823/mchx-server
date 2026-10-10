import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { describe, it } from "node:test";

import { DOWNLOAD, LATEST, PACK_URL, releaseInfo } from "../src/release.js";

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

/**
 * The modpack is the install page's one link, and it is one more hand-built file sitting
 * next to the jar. It goes wrong the same quiet ways — not rebuilt for a release, or built
 * around the wrong jar — and the worst of those is the tester jar, which would install the
 * cheat-enabled build for every new player.
 */
describe("the published modpack matches the published jar", () => {
  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
  const packFile = () => publicDir + new URL(PACK_URL).pathname.slice(1);

  it("exists for the version being released", () => {
    assert.ok(new URL(PACK_URL).pathname.includes(LATEST));
    assert.ok(
      existsSync(packFile()),
      `no modpack for ${LATEST} — run \`python deploy/make-modpack.py\``,
    );
  });

  it("carries exactly the jar the server advertises, and nothing else of ours", () => {
    const entries = zipEntries(readFileSync(packFile()));
    const carried = [...entries.keys()].filter((name) => name.startsWith("overrides/"));
    assert.deepEqual(carried, [`overrides/mods/mchx-${LATEST}.jar`]);

    const sha512 = createHash("sha512").update(entries.get(carried[0]!)!()).digest("hex");
    assert.equal(sha512, DOWNLOAD!.sha512, "the pack was built around a different jar");
  });

  it("says which Minecraft it is for, and where each other mod comes from", () => {
    const entries = zipEntries(readFileSync(packFile()));
    const index = JSON.parse(entries.get("modrinth.index.json")!().toString("utf-8")) as {
      versionId: string;
      dependencies: Record<string, string>;
      files: { path: string; hashes: Record<string, string>; downloads: string[] }[];
    };

    assert.equal(index.versionId, LATEST);
    assert.ok(index.dependencies.minecraft, "no Minecraft version");
    assert.ok(index.dependencies["fabric-loader"], "no loader version");
    assert.ok(index.files.length > 0);
    for (const file of index.files) {
      // Our own mod must arrive from inside the pack, where the test above pins it.
      assert.ok(!/mchx/i.test(file.path), `${file.path} is listed as a download`);
      assert.match(file.hashes.sha512 ?? "", /^[0-9a-f]{128}$/);
      assert.equal(new URL(file.downloads[0]!).protocol, "https:");
    }
  });

  it("is what /api/release hands the install page", () => {
    assert.equal(new URL(PACK_URL).protocol, "https:");
    assert.ok(PACK_URL.endsWith(".mrpack"));
  });
});

/**
 * Just enough of a zip reader to open a pack: the central directory, stored and deflated
 * entries. A dependency for this would be a dependency for one test.
 */
function zipEntries(zip: Buffer): Map<string, () => Buffer> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "not a zip file");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);

  const out = new Map<string, () => Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, "bad central directory entry");
    const method = zip.readUInt16LE(at + 10);
    const packedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf-8", at + 46, at + 46 + nameLength);

    out.set(name, () => {
      // The local header repeats the name and has its own extra field, of its own length.
      const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const packed = zip.subarray(data, data + packedSize);
      return method === 0 ? packed : inflateRawSync(packed);
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
