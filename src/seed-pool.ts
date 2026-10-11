import { randomInt } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Seeds that are known to have something near their spawn.
 *
 * A random seed starts a match wherever it starts it: two in three have no village, no
 * portal worth finishing, no lava and no cave mouth within a hundred blocks of the spawn.
 * A room with the seed filter on draws from this pool instead — seeds that were generated
 * and looked at ahead of time (`seedtool/`, in the parent repository) and kept only if at
 * least one of those four was there.
 *
 * The pool is a file, and it is not in this repository. This repository is public, and
 * the file is a list of seeds with the coordinates of what is worth finding in each: the
 * one thing a player must not be able to look up. It sits beside the database, is put
 * there by hand (`deploy/upload-seed-pool.sh`), and is read from wherever it is — so a
 * server with no pool is a server where the filter cannot be used, not one that fails to
 * start.
 */

/** What a filtered seed has, in the order it is always listed. */
export const SEED_FEATURES = ["village", "ruinedPortal", "lavaPool", "caveEntrance"] as const;
export type SeedFeature = (typeof SEED_FEATURES)[number];

export interface PoolSeed {
  readonly seedId: string;
  readonly seed: bigint;
  /** Which of the four are near the spawn. Never empty: that is what being in the pool means. */
  readonly features: readonly SeedFeature[];
}

/**
 * The Minecraft a pool has to have been generated on to be any use.
 *
 * A seed is only "the one with the village" in the version it was judged in; world
 * generation changes between versions and the village moves or goes. Seeds made for
 * another version are skipped rather than served, which after a Minecraft move leaves the
 * pool empty until it is regenerated — the honest state. Raise this with `minecraftVersion`
 * in `seedtool/gradle.properties`.
 */
export const POOL_MINECRAFT = "26.3";

export class SeedPool {
  private seeds: PoolSeed[] = [];
  private loadedMtimeMs = -1;

  constructor(private readonly path: string) {}

  /** How many seeds can be drawn right now. */
  size(): number {
    this.refresh();
    return this.seeds.length;
  }

  /**
   * One seed, uniformly at random, or null if there are none.
   *
   * No memory of what was drawn before. With a few hundred seeds a repeat is uncommon,
   * and a player who does meet one again has the same advantage the other player in the
   * room has: they are in the same world.
   */
  pick(): PoolSeed | null {
    this.refresh();
    if (this.seeds.length === 0) return null;
    return this.seeds[randomInt(this.seeds.length)]!;
  }

  /**
   * Re-read the file if it has changed.
   *
   * Checked on use rather than watched: a new pool is uploaded while the server runs, and
   * restarting to pick it up would end every match in progress. One `stat` per match
   * start is nothing.
   */
  private refresh(): void {
    let mtimeMs: number;
    try {
      if (!existsSync(this.path)) {
        this.seeds = [];
        this.loadedMtimeMs = -1;
        return;
      }
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;

    try {
      const loaded = parsePool(readFileSync(this.path, "utf8"));
      this.seeds = loaded;
      this.loadedMtimeMs = mtimeMs;
      console.log(`[seed-pool] ${loaded.length} seed(s) for Minecraft ${POOL_MINECRAFT} from ${this.path}`);
    } catch (e) {
      // Half-written, most likely — an upload in progress. Keep what was there and look
      // again next time; do not remember this mtime as loaded.
      console.warn(`[seed-pool] could not read ${this.path}: ${(e as Error).message}`);
    }
  }
}

/** One record per line. A line that is not a usable seed is skipped, not fatal. */
export function parsePool(text: string): PoolSeed[] {
  const seeds: PoolSeed[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed) as {
      seedId?: unknown; seed?: unknown; mcVersion?: unknown; status?: unknown;
      tags?: Record<string, { found?: unknown } | undefined>;
    };
    if (record.status !== "verified" || record.mcVersion !== POOL_MINECRAFT) continue;
    // The seed is a string in the file and must stay one until it is a BigInt: read as a
    // JSON number it loses its low bits and names a different world.
    if (typeof record.seed !== "string" || !/^-?\d+$/.test(record.seed)) continue;
    const features = SEED_FEATURES.filter((name) => record.tags?.[name]?.found === true);
    if (features.length === 0) continue;
    seeds.push({
      seedId: typeof record.seedId === "string" ? record.seedId : record.seed,
      seed: BigInt.asIntN(64, BigInt(record.seed)),
      features,
    });
  }
  return seeds;
}

function defaultPath(): string {
  if (process.env.MCHX_SEED_POOL) return resolve(process.env.MCHX_SEED_POOL);
  // Beside the database: outside the git tree, and inside what a deploy backs up.
  return join(dirname(resolve(process.env.MCHX_DB_PATH ?? "../data/mchx.sqlite")), "seed-pool.jsonl");
}

/** The pool this process serves from. */
export const seedPool = new SeedPool(defaultPath());
