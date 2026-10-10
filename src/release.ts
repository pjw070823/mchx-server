/**
 * Which client build this server will talk to, and where to get it.
 *
 * The mod is enforced from here rather than from the protocol number because the two
 * answer different questions. The protocol version says "can we understand each other";
 * the mod version says "does this client know how to play the game we are about to
 * deal". A mission whose detector only exists in a newer jar breaks nothing at the wire
 * level — the client simply never completes that tile, and if the opponent is on a newer
 * build the board is unfair before the first block is broken.
 *
 * Raising [MINIMUM] locks out every player below it the moment this deploys, so the
 * order is not optional:
 *
 *   1. publish the jar and confirm it is downloadable
 *   2. update LATEST here, deploy — clients are told an update exists
 *   3. only then raise MINIMUM, deploy again
 *
 * Doing 3 before 1 leaves players told to update with nothing to update to.
 */

/** Newest published build. Clients below this are offered the update. */
export const LATEST = "0.1.16";

/**
 * Oldest build allowed to connect. Clients below this are refused.
 *
 * Equal to [LATEST] means "latest or nothing", which is what MCSR Ranked and Draftout
 * both do — with a release every few days, tracking which older builds are still
 * tolerable costs more than it saves. Lower it to leave a grace window for a release
 * that changed nothing a client depends on.
 */
export const MINIMUM = "0.1.1";  // 0.1.16 published; the floor moves in its own deploy

/**
 * The oldest build that runs on the Minecraft version the game is played on.
 *
 * 0.1.16 is the first build for Minecraft 26.3; everything before it is a 26.1.2 jar.
 * That is a different kind of "too old" from [MINIMUM], and it needs a different answer.
 * A client below [MINIMUM] is sent `update_required` with the download, shows an update
 * button, and installs the jar it is given. Doing that to a 26.1.2 client would install
 * a 26.3 jar into a 26.1.2 instance, and Fabric would then refuse to start the game at
 * all — the "update" would be what broke it. The mod cannot change which Minecraft it is
 * running in, so the only honest thing to send is a sentence telling the player to do it.
 *
 * It also has to be a hard line rather than a grace period: the same seed is not
 * promised to generate the same world across Minecraft versions, and two players in
 * different worlds is the one thing a match cannot survive.
 */
export const MINECRAFT_FLOOR = "0.1.16";

/**
 * What a client below [MINECRAFT_FLOOR] is told.
 *
 * Korean, and one line, because of where it lands: it is sent as the message of a
 * `protocol_mismatch` error, which is the one server string every build back to 0.1.13
 * prints verbatim — as a single centred line with no wrapping, on the match-start
 * screen. Too long and the ends run off a small window. No link either; the address is
 * there to be typed.
 */
export const MINECRAFT_MOVED_NOTICE =
  "Hex가 마인크래프트 26.3으로 옮겼습니다. mc-hex.com 에서 다시 설치해 주세요.";

/**
 * Where the jar comes from, and what it must hash to.
 *
 * The hash is served by us rather than read from wherever the file is hosted, so the
 * host alone cannot change what runs on a player's machine — the mod refuses a download
 * whose hash does not match what this server said to expect. That matters because this
 * is the one path in the project that puts new code on someone else's computer.
 *
 * `url` is deliberately just a string: it can point at Modrinth's CDN, a GitHub release
 * asset, or this server, and moving between them is a config change and not a code one.
 */
export interface Download {
  readonly url: string;
  /** Lowercase hex SHA-512 of the jar. */
  readonly sha512: string;
  readonly sizeBytes: number;
}

/**
 * Null would mean "no published jar" — the mod would then report the version gap and
 * stop, rather than offering an update it cannot perform.
 *
 * The file is committed under `public/downloads/` and served by the same static handler
 * as the rest of the site, so a release is one commit: jar, hash and version move
 * together and cannot disagree. Serving it ourselves also means the URL and the hash
 * come from the same place we already trust for everything else.
 */
export const DOWNLOAD: Download | null = {
  url: "https://mc-hex.com/downloads/mchx-0.1.16.jar",
  sha512:
    "3e8e880172824fe722fa42fd5704eb0a37e28834b9a350092bbd44db2bb587da" +
    "ee6b77164035764362a25f4c74d175140d8357c7094e0add98b7d4eac0232bcd",
  sizeBytes: 1571897,
};

/** What the client is told about the newest build. */
export interface ReleaseInfo {
  readonly version: string;
  readonly minimum: string;
  readonly download: Download | null;
}

export function releaseInfo(): ReleaseInfo {
  return { version: LATEST, minimum: MINIMUM, download: DOWNLOAD };
}

/**
 * Order two dotted version strings.
 *
 * Returns <0, 0 or >0 the way a comparator does. Build metadata is ignored, so
 * `0.2.0+mc26.1.2` and `0.2.0` are the same build as far as this is concerned — the
 * metadata names the Minecraft version the jar was built for, and Fabric already refuses
 * to load a jar built for the wrong one. A pre-release suffix (`0.2.0-rc1`) is likewise
 * ignored rather than ordered before the release, because ordering it correctly would
 * mean implementing semver properly for a case this project does not have yet.
 *
 * Missing components count as zero, so `0.2` and `0.2.0` compare equal.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .split("+")[0]!
      .split("-")[0]!
      .split(".")
      .map((p) => Number.parseInt(p, 10));

  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * True when `version` is a shape this server can compare against.
 *
 * Anything else — `unknown` from a jar whose metadata could not be read, `dev-bot` from
 * the test harness — skips the version gate entirely rather than being refused. A gate
 * that cannot read a version has no opinion about it, and refusing on that basis would
 * lock out the dev tools and every future client that reports its build differently.
 * The protocol gate still applies to those connections.
 */
export function isComparable(version: string | null | undefined): version is string {
  if (!version) return false;
  const head = version.split("+")[0]!.split("-")[0]!;
  const parts = head.split(".");
  return parts.length > 0 && parts.every((p) => p.length > 0 && /^\d+$/.test(p));
}

/**
 * Whether a client reporting `version` is allowed to connect at all.
 *
 * `minimum` is a parameter only so a test can reach this gate: while [MINIMUM] sits
 * below [MINECRAFT_FLOOR], every build it would refuse is refused by the floor first.
 */
export function isTooOld(version: string | null | undefined, minimum: string = MINIMUM): boolean {
  return isComparable(version) && compareVersions(version, minimum) < 0;
}

/**
 * Whether a client reporting `version` is a build for a Minecraft version the game has
 * left. Asked before [isTooOld], because the two overlap and this one's answer is the
 * only safe one for a build that satisfies both. See [MINECRAFT_FLOOR].
 */
export function isOnOldMinecraft(
  version: string | null | undefined,
  floor: string = MINECRAFT_FLOOR,
): boolean {
  return isComparable(version) && compareVersions(version, floor) < 0;
}

/** Whether a client is allowed in but has an update waiting. */
export function isOutdated(version: string | null | undefined): boolean {
  return isComparable(version) && compareVersions(version, LATEST) < 0;
}
