import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clampInt, matchId, parseJsonArray, parseJsonObject } from "../src/api-routes.js";

describe("matchId", () => {
  it("accepts a positive integer id", () => {
    assert.equal(matchId("1"), 1);
    assert.equal(matchId("4210"), 4210);
  });

  it("rejects everything outside the AUTOINCREMENT id space", () => {
    // `Number()` happily takes all of these, which is why the check is explicit.
    for (const bad of ["0", "-3", "1.5", "1e3", "abc", "", " ", "9007199254740993"]) {
      assert.equal(matchId(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it("rejects a path segment that only looks numeric", () => {
    assert.equal(matchId("12abc"), null);
    assert.equal(matchId("0x10"), null);
  });
});

describe("stored JSON columns", () => {
  it("reads back what was written", () => {
    assert.deepEqual(parseJsonArray('[{"tileId":"0,0"}]'), [{ tileId: "0,0" }]);
    assert.deepEqual(parseJsonObject('{"rated":true}'), { rated: true });
  });

  it("degrades to empty rather than throwing on a bad column", () => {
    // A truncated write must not take the whole route down with a 500.
    for (const bad of [null, "", "{", "not json"]) {
      assert.deepEqual(parseJsonArray(bad), []);
      assert.equal(parseJsonObject(bad), null);
    }
  });

  it("keeps the two shapes apart", () => {
    // An object in the board column would otherwise be spread into a bogus board.
    assert.deepEqual(parseJsonArray('{"a":1}'), []);
    assert.equal(parseJsonObject("[1,2]"), null);
  });
});

describe("clampInt", () => {
  it("clamps to the given bounds and floors fractions", () => {
    assert.equal(clampInt("999", 20, 1, 100), 100);
    assert.equal(clampInt("-5", 20, 1, 100), 1);
    assert.equal(clampInt("7.9", 20, 1, 100), 7);
  });

  it("falls back when the value is not a number", () => {
    assert.equal(clampInt(undefined, 20, 1, 100), 20);
    assert.equal(clampInt("abc", 20, 1, 100), 20);
  });
});
