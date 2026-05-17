import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Difficulty } from "./protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MissionDetector = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inventory_count"),
    item: z.string(),
    count: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("inventory_distinct"),
    candidates: z.array(z.string()).min(1),
    minDistinct: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("inventory_collection"),
    items: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal("inventory_any_of"),
    items: z.array(z.string()).min(1),
    totalCount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("inventory_potion"),
    items: z.array(z.string()).min(1),
    excludePotions: z.array(z.string()).default([]),
    totalCount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("advancement"),
    id: z.string(),
  }),
  z.object({
    type: z.literal("chest_distinct_27"),
  }),
  // Vanilla statistic threshold. statType = StatType registry id
  // (`minecraft:custom`, `minecraft:killed`, `minecraft:mined`, ...),
  // statKey = the inner registry id (`minecraft:jump`, `minecraft:villager`, ...).
  z.object({
    type: z.literal("stat"),
    statType: z.string(),
    statKey: z.string(),
    threshold: z.number().int().positive(),
  }),
  // Player died from a specific damage cause. `source` is interpreted on the
  // mod side — currently understood values: "lava" | "dripstone" | "arrow_self".
  z.object({
    type: z.literal("death_by"),
    source: z.string(),
  }),
  // Player currently has a given mob effect active (e.g. `minecraft:dolphins_grace`).
  z.object({
    type: z.literal("active_effect"),
    effect: z.string(),
  }),
  // Bucket for one-off missions whose detection logic is hardcoded to a
  // specific key in the mod (e.g. fall-and-survive, bed-respawn, baby age-lock,
  // boat-with-monster, banner-with-pattern). Saves adding a typed detector for
  // every one-shot mechanic.
  z.object({
    type: z.literal("custom"),
    key: z.string(),
  }),
]);
export type MissionDetector = z.infer<typeof MissionDetector>;

const Mission = z.object({
  id: z.string(),
  displayName: z.string(),
  difficulty: Difficulty,
  detector: MissionDetector,
});
export type Mission = z.infer<typeof Mission>;

const MissionsFile = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  missions: z.array(Mission),
});

function resolveMissionsPath(): string {
  if (process.env.MCHX_MISSIONS_PATH) return process.env.MCHX_MISSIONS_PATH;
  const candidates = [
    // dev: server/src → repo/shared
    resolve(__dirname, "../../shared/missions.json"),
    // server folder colocated with shared (e.g. /opt/mchx/server + /opt/mchx/shared)
    resolve(__dirname, "../shared/missions.json"),
    // missions.json copied next to server folder
    resolve(__dirname, "../missions.json"),
    // missions.json copied into server folder root
    resolve(__dirname, "./missions.json"),
    // launched from repo root
    resolve(process.cwd(), "shared/missions.json"),
    // launched from server dir with missions.json next to it
    resolve(process.cwd(), "missions.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "missions.json not found. Tried:\n  " +
      candidates.join("\n  ") +
      "\nSet MCHX_MISSIONS_PATH env var to override.",
  );
}

const MISSIONS_PATH = resolveMissionsPath();

function loadMissions(): Mission[] {
  console.log(`[mchx] loading missions from ${MISSIONS_PATH}`);
  const raw = readFileSync(MISSIONS_PATH, "utf-8");
  const parsed = MissionsFile.parse(JSON.parse(raw));
  validateCounts(parsed.missions);
  return parsed.missions;
}

function validateCounts(missions: Mission[]): void {
  const byDiff: Record<Difficulty, Mission[]> = { easy: [], medium: [], hard: [] };
  for (const m of missions) byDiff[m.difficulty].push(m);

  // Board has fixed slot counts per difficulty (5x5 = 12 easy + 8 medium + 5 hard).
  // We require at least that many candidates in each tier; if there are MORE,
  // `buildBoard` shuffles and picks a subset per match for variety.
  const minRequired: Record<Difficulty, number> = { easy: 12, medium: 8, hard: 5 };
  for (const d of ["easy", "medium", "hard"] as const) {
    if (byDiff[d].length < minRequired[d]) {
      throw new Error(
        `missions.json: need at least ${minRequired[d]} ${d} missions, got ${byDiff[d].length}`,
      );
    }
  }

  const ids = new Set<string>();
  for (const m of missions) {
    if (ids.has(m.id)) throw new Error(`duplicate mission id: ${m.id}`);
    ids.add(m.id);
  }
}

export const ALL_MISSIONS: readonly Mission[] = Object.freeze(loadMissions());

export const MISSIONS_BY_DIFFICULTY: Readonly<Record<Difficulty, readonly Mission[]>> =
  Object.freeze({
    easy: Object.freeze(ALL_MISSIONS.filter((m) => m.difficulty === "easy")),
    medium: Object.freeze(ALL_MISSIONS.filter((m) => m.difficulty === "medium")),
    hard: Object.freeze(ALL_MISSIONS.filter((m) => m.difficulty === "hard")),
  });

export function getMission(id: string): Mission | undefined {
  return ALL_MISSIONS.find((m) => m.id === id);
}
