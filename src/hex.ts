import type { BoardTile, Side, TileId } from "./protocol.js";
import { ALL_MISSIONS, MISSIONS_BY_DIFFICULTY } from "./missions.js";
import type { Difficulty } from "./protocol.js";

export const BOARD_SIZE = 5;

export function tileId(q: number, r: number): TileId {
  return `${q},${r}` as TileId;
}

export function parseTileId(id: TileId): { q: number; r: number } {
  const [q, r] = id.split(",").map(Number) as [number, number];
  return { q, r };
}

/**
 * Difficulty assigned by anti-diagonal d = q + r:
 *   d == 4              → Hard (5 tiles)
 *   d ∈ {3, 5}          → Medium (8 tiles)
 *   d ∈ {0,1,2,6,7,8}   → Easy (12 tiles)
 */
export function difficultyFor(q: number, r: number): Difficulty {
  const d = q + r;
  if (d === 4) return "hard";
  if (d === 3 || d === 5) return "medium";
  return "easy";
}

export function allCoords(): { q: number; r: number }[] {
  const out: { q: number; r: number }[] = [];
  for (let q = 0; q < BOARD_SIZE; q++) {
    for (let r = 0; r < BOARD_SIZE; r++) {
      out.push({ q, r });
    }
  }
  return out;
}

const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [+1, 0],
  [-1, 0],
  [0, +1],
  [0, -1],
  [+1, -1],
  [-1, +1],
]);

export function neighbors(q: number, r: number): TileId[] {
  const out: TileId[] = [];
  for (const [dq, dr] of NEIGHBOR_OFFSETS) {
    const nq = q + dq;
    const nr = r + dr;
    if (nq >= 0 && nq < BOARD_SIZE && nr >= 0 && nr < BOARD_SIZE) {
      out.push(tileId(nq, nr));
    }
  }
  return out;
}

/**
 * Side A connects r=0 edge ↔ r=4 edge (top-right ↔ bottom-left in rotated view).
 * Side B connects q=0 edge ↔ q=4 edge (top-left ↔ bottom-right in rotated view).
 */
function isOnEdge(side: Side, edge: "start" | "end", q: number, r: number): boolean {
  if (side === "A") return edge === "start" ? r === 0 : r === BOARD_SIZE - 1;
  return edge === "start" ? q === 0 : q === BOARD_SIZE - 1;
}

/**
 * Pure win-detection: returns true iff `claimed` for `side` already forms a winning chain.
 * BFS from start-edge tiles through claimed neighbors, succeed if we reach end-edge.
 */
export function hasWon(side: Side, claimed: ReadonlyMap<TileId, Side>): boolean {
  const ownTiles = new Set<TileId>();
  const startSeeds: TileId[] = [];
  for (const [tid, owner] of claimed) {
    if (owner !== side) continue;
    ownTiles.add(tid);
    const { q, r } = parseTileId(tid);
    if (isOnEdge(side, "start", q, r)) startSeeds.push(tid);
  }

  const visited = new Set<TileId>();
  const queue = [...startSeeds];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const { q, r } = parseTileId(cur);
    if (isOnEdge(side, "end", q, r)) return true;
    for (const n of neighbors(q, r)) {
      if (ownTiles.has(n) && !visited.has(n)) queue.push(n);
    }
  }
  return false;
}

function shuffle<T>(arr: readonly T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Build a 25-tile board with missions shuffled within each difficulty tier.
 */
export function buildBoard(seedRand: () => number): BoardTile[] {
  const easy = shuffle(MISSIONS_BY_DIFFICULTY.easy, seedRand);
  const medium = shuffle(MISSIONS_BY_DIFFICULTY.medium, seedRand);
  const hard = shuffle(MISSIONS_BY_DIFFICULTY.hard, seedRand);

  const queues = { easy: [...easy], medium: [...medium], hard: [...hard] };
  const out: BoardTile[] = [];
  for (const { q, r } of allCoords()) {
    const diff = difficultyFor(q, r);
    const m = queues[diff].pop();
    if (!m) throw new Error(`mission queue exhausted for ${diff} at (${q},${r})`);
    out.push({ tileId: tileId(q, r), q, r, difficulty: diff, missionId: m.id });
  }
  return out;
}

/**
 * Mulberry32 — small, deterministic PRNG so the same seed produces the same shuffle.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// sanity: ensure missions.json totals match the board exactly
if (ALL_MISSIONS.length !== BOARD_SIZE * BOARD_SIZE) {
  throw new Error(
    `mission count ${ALL_MISSIONS.length} ≠ board size ${BOARD_SIZE * BOARD_SIZE}`,
  );
}
