import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeNewElo, expectedScore, kFactor } from "../src/elo.js";

describe("kFactor", () => {
  it("steps down at 30 and 100 games", () => {
    assert.equal(kFactor(0), 40);
    assert.equal(kFactor(29), 40);
    assert.equal(kFactor(30), 24);
    assert.equal(kFactor(99), 24);
    assert.equal(kFactor(100), 16);
    assert.equal(kFactor(10_000), 16);
  });
});

describe("expectedScore", () => {
  it("is 0.5 between equal ratings", () => {
    assert.equal(expectedScore(500, 500), 0.5);
  });

  it("is ~0.909 with a 400-point lead", () => {
    assert.ok(Math.abs(expectedScore(900, 500) - 1 / 1.1) < 1e-12);
  });

  it("is symmetric — both sides' expectations sum to 1", () => {
    for (const [a, b] of [[500, 500], [800, 400], [1200, 431], [100, 2000]]) {
      assert.ok(Math.abs(expectedScore(a!, b!) + expectedScore(b!, a!) - 1) < 1e-12);
    }
  });
});

describe("computeNewElo", () => {
  it("moves by half the K-factor for a win between equal players", () => {
    const r = computeNewElo(500, 500, 0, 1);
    assert.deepEqual(r, { before: 500, after: 520, delta: 20 });
  });

  it("moves the same amount downward on a loss", () => {
    assert.deepEqual(computeNewElo(500, 500, 0, 0), { before: 500, after: 480, delta: -20 });
  });

  it("leaves an even match unchanged on a draw", () => {
    assert.deepEqual(computeNewElo(500, 500, 0, 0.5), { before: 500, after: 500, delta: 0 });
  });

  it("keeps `after - before === delta`", () => {
    for (const games of [0, 30, 100]) {
      for (const score of [0, 0.5, 1] as const) {
        const r = computeNewElo(742, 613, games, score);
        assert.equal(r.after - r.before, r.delta);
      }
    }
  });

  it("rewards an upset more than an expected win", () => {
    const upset = computeNewElo(400, 900, 0, 1).delta;
    const expected = computeNewElo(900, 400, 0, 1).delta;
    assert.ok(upset > expected, `upset ${upset} should beat expected ${expected}`);
  });

  it("is roughly zero-sum when both players share a K-factor", () => {
    const winner = computeNewElo(700, 500, 0, 1);
    const loser = computeNewElo(500, 700, 0, 0);
    assert.ok(Math.abs(winner.delta + loser.delta) <= 1, "rounding should keep it within 1 point");
  });

  it("shrinks rating swings as games played grows", () => {
    const rookie = computeNewElo(500, 500, 0, 1).delta;
    const veteran = computeNewElo(500, 500, 100, 1).delta;
    assert.ok(rookie > veteran, `${rookie} should exceed ${veteran}`);
  });
});
