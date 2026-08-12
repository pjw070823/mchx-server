import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_SIZE,
  allCoords,
  buildBoard,
  difficultyFor,
  hasWon,
  mulberry32,
  neighbors,
  parseTileId,
  tileId,
} from "../src/hex.js";
import type { Side, TileId } from "../src/protocol.js";

/** Build a claim map from `[tileId, side]` pairs. */
function claims(entries: Array<[string, Side]>): Map<TileId, Side> {
  return new Map(entries.map(([id, side]) => [id as TileId, side]));
}

/** Every tile in `ids` claimed by `side`. */
function allBy(side: Side, ids: string[]): Map<TileId, Side> {
  return claims(ids.map((id) => [id, side]));
}

describe("tileId / parseTileId", () => {
  it("round-trips every board coordinate", () => {
    for (const { q, r } of allCoords()) {
      assert.deepEqual(parseTileId(tileId(q, r)), { q, r });
    }
  });
});

describe("difficultyFor", () => {
  it("assigns by the anti-diagonal q+r", () => {
    assert.equal(difficultyFor(2, 2), "hard"); // d == 4
    assert.equal(difficultyFor(0, 4), "hard");
    assert.equal(difficultyFor(4, 0), "hard");
    assert.equal(difficultyFor(0, 3), "medium"); // d == 3
    assert.equal(difficultyFor(1, 4), "medium"); // d == 5
    assert.equal(difficultyFor(0, 0), "easy"); // d == 0
    assert.equal(difficultyFor(4, 4), "easy"); // d == 8
  });

  it("produces exactly 12 easy / 8 medium / 5 hard slots on a 5x5 board", () => {
    const counts = { easy: 0, medium: 0, hard: 0 };
    for (const { q, r } of allCoords()) counts[difficultyFor(q, r)]++;
    assert.deepEqual(counts, { easy: 12, medium: 8, hard: 5 });
  });

  /**
   * The hard tiles are not merely "the middle" — they are a cut. No winning chain, for
   * either side, can avoid all five, which is the entire reason the difficulty is placed
   * by q+r rather than by distance from the centre.
   *
   * The proof is one line: q+r moves by at most 1 per step, and every chain starts on a
   * tile with q+r ≤ 4 and ends on one with q+r ≥ 4, so it lands on exactly 4 somewhere.
   * Pinning the step size pins the property.
   */
  it("puts the hard tiles on a line no chain can step over", () => {
    for (const { q, r } of allCoords()) {
      for (const n of neighbors(q, r)) {
        const { q: nq, r: nr } = parseTileId(n);
        const jump = Math.abs(nq + nr - (q + r));
        assert.ok(jump <= 1, `(${q},${r}) -> (${nq},${nr}) jumps ${jump} anti-diagonals`);
      }
    }

    // And the endpoints straddle it: every start tile is at or below d=4, every goal at
    // or above. Together with the step size, crossing d=4 is unavoidable.
    for (let i = 0; i < BOARD_SIZE; i++) {
      assert.ok(i + 0 <= 4 && i + (BOARD_SIZE - 1) >= 4, "A's edges straddle the hard line");
      assert.ok(0 + i <= 4 && BOARD_SIZE - 1 + i >= 4, "B's edges straddle the hard line");
    }
  });

  it("refuses a win to a side that claims everything short of the hard line", () => {
    // 10 tiles, all connected, touching one full edge for each side — and still no win,
    // because the chain has to step onto d=4 to reach the far side.
    const below = allCoords().filter(({ q, r }) => q + r < 4).map(({ q, r }) => tileId(q, r));
    assert.equal(below.length, 10);
    assert.equal(hasWon("A", allBy("A", below)), false);
    assert.equal(hasWon("B", allBy("B", below)), false);
  });
});

describe("neighbors", () => {
  it("returns 6 neighbours in the interior", () => {
    assert.equal(neighbors(2, 2).length, 6);
  });

  it("clamps at the board edges", () => {
    // (0,0): only (+1,0) and (0,+1) stay in bounds — (+1,-1) and (-1,+1) leave it.
    assert.deepEqual(new Set(neighbors(0, 0)), new Set(["1,0", "0,1"]));
    assert.deepEqual(new Set(neighbors(4, 4)), new Set(["3,4", "4,3"]));
  });

  it("is symmetric", () => {
    for (const { q, r } of allCoords()) {
      for (const n of neighbors(q, r)) {
        const { q: nq, r: nr } = parseTileId(n);
        assert.ok(
          neighbors(nq, nr).includes(tileId(q, r)),
          `${tileId(q, r)} -> ${n} is not mutual`,
        );
      }
    }
  });
});

describe("hasWon", () => {
  it("is false with no claims", () => {
    assert.equal(hasWon("A", claims([])), false);
  });

  it("A wins on a straight r=0..4 column", () => {
    const claimed = allBy("A", ["0,0", "0,1", "0,2", "0,3", "0,4"]);
    assert.equal(hasWon("A", claimed), true);
    // Same tiles do NOT win for B — they never span q=0..4.
    assert.equal(hasWon("B", allBy("B", ["0,0", "0,1", "0,2", "0,3", "0,4"])), false);
  });

  it("B wins on a straight q=0..4 row", () => {
    const claimed = allBy("B", ["0,0", "1,0", "2,0", "3,0", "4,0"]);
    assert.equal(hasWon("B", claimed), true);
    assert.equal(hasWon("A", allBy("A", ["0,0", "1,0", "2,0", "3,0", "4,0"])), false);
  });

  it("A wins on a diagonal chain via the (-1,+1) offset", () => {
    const claimed = allBy("A", ["4,0", "3,1", "2,2", "1,3", "0,4"]);
    assert.equal(hasWon("A", claimed), true);
  });

  it("is false when the chain is one tile short of the far edge", () => {
    const claimed = allBy("A", ["0,0", "0,1", "0,2", "0,3"]);
    assert.equal(hasWon("A", claimed), false);
  });

  it("is false when the chain is broken in the middle", () => {
    const claimed = allBy("A", ["0,0", "0,1", "0,3", "0,4"]);
    assert.equal(hasWon("A", claimed), false);
  });

  it("does not route a chain through the opponent's tiles", () => {
    const claimed = claims([
      ["0,0", "A"],
      ["0,1", "A"],
      ["0,2", "B"], // opponent blocks the middle
      ["0,3", "A"],
      ["0,4", "A"],
    ]);
    assert.equal(hasWon("A", claimed), false);
  });

  it("cannot be won by a single tile", () => {
    for (const { q, r } of allCoords()) {
      assert.equal(hasWon("A", allBy("A", [tileId(q, r)])), false);
      assert.equal(hasWon("B", allBy("B", [tileId(q, r)])), false);
    }
  });

  it("finds a winning chain that detours sideways", () => {
    // Start at r=0, wander across q, still reach r=4.
    const claimed = allBy("A", ["2,0", "2,1", "3,1", "3,2", "3,3", "2,3", "2,4"]);
    assert.equal(hasWon("A", claimed), true);
  });
});

describe("buildBoard", () => {
  it("fills all 25 tiles with matching difficulty and unique missions", () => {
    const board = buildBoard(mulberry32(12345));
    assert.equal(board.length, BOARD_SIZE * BOARD_SIZE);

    const seenTiles = new Set<string>();
    const seenMissions = new Set<string>();
    for (const t of board) {
      assert.equal(t.tileId, tileId(t.q, t.r));
      assert.equal(t.difficulty, difficultyFor(t.q, t.r));
      assert.ok(!seenTiles.has(t.tileId), `duplicate tile ${t.tileId}`);
      assert.ok(!seenMissions.has(t.missionId), `duplicate mission ${t.missionId}`);
      seenTiles.add(t.tileId);
      seenMissions.add(t.missionId);
    }
    assert.equal(seenTiles.size, 25);
  });

  it("is deterministic for a given seed", () => {
    assert.deepEqual(buildBoard(mulberry32(999)), buildBoard(mulberry32(999)));
  });

  it("produces different mission layouts for different seeds", () => {
    const a = buildBoard(mulberry32(1));
    const b = buildBoard(mulberry32(2));
    assert.notDeepEqual(
      a.map((t) => t.missionId),
      b.map((t) => t.missionId),
    );
  });
});

describe("mulberry32", () => {
  it("is deterministic and stays in [0,1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      assert.equal(v, b());
      assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    }
  });
});
