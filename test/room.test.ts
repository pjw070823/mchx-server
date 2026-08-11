import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RoomConfig } from "../src/room.js";
// Sets MCHX_DB_PATH as a side effect. Must come before the dynamic import below.
import {
  A_WINNING_CHAIN, boardOf, FAST, FakeWs, missionFor, muteConsole, seat, VERIFIED,
} from "./helpers.js";

const { Room, RoomRegistry } = await import("../src/room.js");

let restoreConsole: () => void;
before(() => { restoreConsole = muteConsole(); });
after(() => restoreConsole());

/**
 * A 2-player room already in `playing` with the countdown elapsed.
 *
 * Seats are unauthenticated (no uuid) by default, which is what a guest looks like.
 * Pass uuids to model two verified accounts — the only case that can move ratings.
 */
function playingRoom(
  config: Partial<RoomConfig> = FAST,
  accounts: { a?: string | null; b?: string | null } = {},
) {
  const room = new Room(config);
  const a = seat(room, "p1", "Alice", accounts.a ?? null);
  const b = seat(room, "p2", "Bob", accounts.b ?? null);
  room.startMatchByHost("p1");
  room.markReady("p1");
  room.markReady("p2");
  return { room, a, b };
}

describe("Room — seating", () => {
  it("makes the first player host and assigns sides A then B", () => {
    const room = new Room(FAST);
    const a = seat(room, "p1", "Alice");
    const b = seat(room, "p2", "Bob");

    assert.equal(room.hostId, "p1");
    assert.equal(a.session?.side, "A");
    assert.equal(b.session?.side, "B");
    assert.equal(room.size(), 2);
  });

  it("refuses a third player in a 1v1 room", () => {
    const room = new Room(FAST);
    seat(room, "p1", "Alice");
    seat(room, "p2", "Bob");
    assert.equal(seat(room, "p3", "Carol").session, null);
    assert.equal(room.size(), 2);
  });

  it("refuses joins once the match is under way", () => {
    const { room } = playingRoom();
    assert.equal(seat(room, "p3", "Carol").session, null);
  });

  it("hands the host role to the remaining player when the host leaves pre-match", () => {
    const room = new Room(FAST);
    seat(room, "p1", "Alice");
    seat(room, "p2", "Bob");
    room.removePlayer("p1");
    assert.equal(room.hostId, "p2");
  });
});

describe("Room — settings", () => {
  it("only lets the host change settings", () => {
    const room = new Room(FAST);
    seat(room, "p1", "Alice");
    seat(room, "p2", "Bob");

    assert.equal(room.updateSettings("p2", { rated: false }), false);
    assert.equal(room.settings.rated, true);
    assert.equal(room.updateSettings("p1", { rated: false }), true);
    assert.equal(room.settings.rated, false);
  });

  it("merges only the provided fields", () => {
    const room = new Room(FAST);
    seat(room, "p1", "Alice");
    const before = { ...room.settings };
    room.updateSettings("p1", { saturation: !before.saturation });

    assert.equal(room.settings.saturation, !before.saturation);
    assert.equal(room.settings.inventorySave, before.inventorySave);
    assert.equal(room.settings.nightVision, before.nightVision);
    assert.equal(room.settings.gameMode, before.gameMode);
  });

  it("rejects changes once the match is under way", () => {
    const { room } = playingRoom();
    assert.equal(room.updateSettings("p1", { rated: false }), false);
  });
});

describe("Room — starting a match", () => {
  it("refuses a non-host and an under-filled room", () => {
    const room = new Room(FAST);
    seat(room, "p1", "Alice");
    assert.deepEqual(room.startMatchByHost("p1"), { ok: false, reason: "not_ready" });

    seat(room, "p2", "Bob");
    assert.deepEqual(room.startMatchByHost("p2"), { ok: false, reason: "not_host" });
    assert.deepEqual(room.startMatchByHost("p1"), { ok: true });
  });

  it("sends both players a 25-tile board and flips to playing", () => {
    const room = new Room(FAST);
    const a = seat(room, "p1", "Alice");
    const b = seat(room, "p2", "Bob");
    room.startMatchByHost("p1");

    assert.equal(room.status, "playing");
    for (const sock of [a.sock, b.sock]) {
      const board = boardOf(sock);
      assert.equal(board.length, 25);
      assert.equal(new Set(board.map((t) => t.tileId)).size, 25);
    }
    assert.equal(a.sock.last("match_start")?.yourSide, "A");
    assert.equal(b.sock.last("match_start")?.yourSide, "B");
  });

  it("broadcasts the countdown only once every player is ready", () => {
    const room = new Room(FAST);
    const a = seat(room, "p1", "Alice");
    const b = seat(room, "p2", "Bob");
    room.startMatchByHost("p1");

    room.markReady("p1");
    assert.equal(a.sock.all("countdown_start").length, 0);

    room.markReady("p2");
    assert.equal(a.sock.all("countdown_start").length, 1);
    assert.equal(b.sock.all("countdown_start").length, 1);
  });
});

describe("Room — claims", () => {
  it("accepts a valid claim and broadcasts it to both sides", () => {
    const { room, a, b } = playingRoom();
    const board = boardOf(a.sock);
    a.sock.clear();
    b.sock.clear();

    room.attemptClaim("p1", "2,2", missionFor(board, "2,2"));

    const claimed = a.sock.last("tile_claimed");
    assert.equal(claimed?.tileId, "2,2");
    assert.equal(claimed?.side, "A");
    assert.equal(b.sock.last("tile_claimed")?.tileId, "2,2");
  });

  it("rejects a claim before the countdown has been armed", () => {
    const room = new Room(FAST);
    const a = seat(room, "p1", "Alice");
    seat(room, "p2", "Bob");
    room.startMatchByHost("p1");
    const board = boardOf(a.sock);
    a.sock.clear();

    room.attemptClaim("p1", "2,2", missionFor(board, "2,2"));
    assert.equal(a.sock.last("claim_rejected")?.reason, "countdown");
  });

  it("rejects an unknown tile and a mismatched mission", () => {
    const { room, a } = playingRoom();
    const board = boardOf(a.sock);
    a.sock.clear();

    room.attemptClaim("p1", "9,9", "whatever");
    assert.equal(a.sock.last("claim_rejected")?.reason, "unknown_tile");

    room.attemptClaim("p1", "1,1", missionFor(board, "2,2"));
    assert.equal(a.sock.last("claim_rejected")?.reason, "wrong_mission");
  });

  it("rejects a tile the opponent already took", () => {
    const { room, a, b } = playingRoom();
    const board = boardOf(a.sock);
    room.attemptClaim("p1", "3,3", missionFor(board, "3,3"));
    b.sock.clear();

    room.attemptClaim("p2", "3,3", missionFor(board, "3,3"));
    assert.equal(b.sock.last("claim_rejected")?.reason, "already_claimed");
  });

  it("rejects a claim fired before the anti-cheat window opens", () => {
    const { room, a } = playingRoom({ ...FAST, minTimeToFirstClaimMs: 10_000 });
    const board = boardOf(a.sock);
    a.sock.clear();

    room.attemptClaim("p1", "2,2", missionFor(board, "2,2"));
    assert.equal(a.sock.last("claim_rejected")?.reason, "too_fast");
  });

  it("rejects rapid-fire claims inside the per-claim interval", () => {
    const { room, a } = playingRoom({ ...FAST, minIntervalBetweenClaimsMs: 10_000 });
    const board = boardOf(a.sock);
    a.sock.clear();

    room.attemptClaim("p1", "2,2", missionFor(board, "2,2"));
    assert.equal(a.sock.last("tile_claimed")?.tileId, "2,2");

    room.attemptClaim("p1", "1,1", missionFor(board, "1,1"));
    assert.equal(a.sock.last("claim_rejected")?.reason, "too_fast");
  });
});

describe("Room — winning", () => {
  it("ends the match when a side connects its two edges", () => {
    const { room, a, b } = playingRoom();
    const board = boardOf(a.sock);

    for (const tile of A_WINNING_CHAIN.slice(0, 4)) {
      room.attemptClaim("p1", tile, missionFor(board, tile));
    }
    assert.equal(a.sock.all("match_end").length, 0, "must not end before the chain closes");

    const last = A_WINNING_CHAIN[4]!;
    room.attemptClaim("p1", last, missionFor(board, last));

    const ended = a.sock.last("match_end");
    assert.equal(ended?.winner, "A");
    assert.equal(ended?.reason, "connection");
    assert.equal(b.sock.last("match_end")?.winner, "A");
  });

  it("reports an ELO change for both players when both accounts are verified", () => {
    const { room, a } = playingRoom(FAST, VERIFIED);
    const board = boardOf(a.sock);
    for (const tile of A_WINNING_CHAIN) {
      room.attemptClaim("p1", tile, missionFor(board, tile));
    }

    const changes = a.sock.last("match_end")?.eloChanges as Record<string, { delta: number }>;
    assert.ok(changes.p1 && changes.p2, "both players should get an elo entry");
    assert.ok(changes.p1.delta > 0, "winner should gain rating");
    assert.ok(changes.p2.delta < 0, "loser should lose rating");
  });

  it("refuses to rate a match with an unauthenticated player", () => {
    // A session only carries a uuid once Mojang confirmed it, so a guest must not be
    // able to move anyone's rating — including their opponent's.
    const { room, a } = playingRoom(FAST, { a: VERIFIED.a, b: null });
    const board = boardOf(a.sock);
    for (const tile of A_WINNING_CHAIN) {
      room.attemptClaim("p1", tile, missionFor(board, tile));
    }

    const ended = a.sock.last("match_end");
    assert.equal(ended?.winner, "A", "the match still resolves normally");
    assert.deepEqual(ended?.eloChanges, {}, "but nobody's rating moves");
  });

  it("refuses to rate a match played by one account against itself", () => {
    const { room, a } = playingRoom(FAST, { a: VERIFIED.a, b: VERIFIED.a });
    const board = boardOf(a.sock);
    for (const tile of A_WINNING_CHAIN) {
      room.attemptClaim("p1", tile, missionFor(board, tile));
    }
    assert.deepEqual(a.sock.last("match_end")?.eloChanges, {});
  });

  it("returns to waiting so the room is rematch-ready, with a fresh seed", () => {
    const { room, a } = playingRoom();
    const firstSeed = a.sock.last("match_start")?.seed;
    const board = boardOf(a.sock);
    for (const tile of A_WINNING_CHAIN) {
      room.attemptClaim("p1", tile, missionFor(board, tile));
    }

    assert.equal(room.status, "waiting");
    assert.deepEqual(room.startMatchByHost("p1"), { ok: true });
    assert.notEqual(a.sock.last("match_start")?.seed, firstSeed);
  });

  it("rejects claims once the match has settled", () => {
    const { room, a } = playingRoom();
    const board = boardOf(a.sock);
    for (const tile of A_WINNING_CHAIN) {
      room.attemptClaim("p1", tile, missionFor(board, tile));
    }
    a.sock.clear();

    room.attemptClaim("p1", "4,4", missionFor(board, "4,4"));
    assert.equal(a.sock.last("claim_rejected")?.reason, "match_not_active");
  });
});

describe("Room — ranked rooms", () => {
  /** A ranked room the matchmaker would have built: no host, fixed settings. */
  function rankedRoom(config: Partial<RoomConfig> = FAST) {
    const room = new Room(config, "ranked");
    const a = seat(room, "p1", "Alice", VERIFIED.a);
    const b = seat(room, "p2", "Bob", VERIFIED.b);
    room.start();
    room.markReady("p1");
    room.markReady("p2");
    return { room, a, b };
  }

  function winAsA(room: InstanceType<typeof Room>, sock: FakeWs) {
    const board = boardOf(sock);
    for (const tile of A_WINNING_CHAIN) room.attemptClaim("p1", tile, missionFor(board, tile));
  }

  it("has no host and refuses every host-only command", () => {
    const room = new Room(FAST, "ranked");
    seat(room, "p1", "Alice", VERIFIED.a);

    assert.equal(room.hostId, null, "a ranked room must never promote a host");
    assert.equal(room.startMatchByHost("p1").reason, "not_host");
    assert.equal(room.updateSettings("p1", { rated: false }), false);
  });

  it("uses the fixed ladder preset, not whatever a custom room defaults to", () => {
    const room = new Room(FAST, "ranked");
    // `rated` is the load-bearing one: nothing may opt a ranked match out of rating.
    assert.equal(room.settings.rated, true);
    assert.equal(room.settings.gameMode, "1v1");
  });

  it("stays ended after a match instead of reopening for a rematch", () => {
    const { room, a } = rankedRoom();
    winAsA(room, a.sock);

    assert.equal(room.status, "ended");
    // A stranger holding the code must not be able to take a freed seat.
    room.forceRemovePlayer("p2");
    assert.equal(room.addPlayer("p3", "Mallory", null, new FakeWs().ws), null);
  });

  it("releases both accounts as soon as the match ends", () => {
    // Otherwise neither player could re-queue until the room was reaped.
    const registry = new RoomRegistry();
    const room = registry.create(FAST, "ranked");
    const a = seat(room, "p1", "Alice", VERIFIED.a);
    seat(room, "p2", "Bob", VERIFIED.b);
    room.start();
    room.markReady("p1");
    room.markReady("p2");
    winAsA(room, a.sock);

    assert.equal(registry.findRoomContainingUuid(VERIFIED.a), null);
    assert.equal(registry.findRoomContainingUuid(VERIFIED.b), null);
    assert.equal(registry.listActive().length, 0, "an ended room is not worth listing");
  });

  it("still lets a custom room rematch", () => {
    // Guard against over-applying the ranked fix to the path it must not touch.
    const { room, a } = playingRoom();
    winAsA(room, a.sock);
    assert.equal(room.status, "waiting");
  });

  it("reports its origin in the public summary", () => {
    assert.equal(new Room(FAST, "ranked").summary().origin, "ranked");
    assert.equal(new Room(FAST).summary().origin, "custom");
  });
});

describe("Room — world_ready deadline", () => {
  it("forfeits the side whose world never loaded", async () => {
    const room = new Room({ ...FAST, readyTimeoutMs: 20 }, "ranked");
    const a = seat(room, "p1", "Alice", VERIFIED.a);
    seat(room, "p2", "Bob", VERIFIED.b);
    room.start();
    room.markReady("p1"); // Bob never reports in

    await new Promise((r) => setTimeout(r, 60));

    const ended = a.sock.last("match_end");
    assert.ok(ended, "a match nobody can start must not hang forever");
    assert.equal(ended.winner, "A", "the side that was ready should be awarded the win");
  });

  it("ends with no winner when neither side loaded", () => {
    // Nobody earned it, so nobody gets it.
    const room = new Room({ ...FAST, readyTimeoutMs: 20 }, "ranked");
    const a = seat(room, "p1", "Alice", VERIFIED.a);
    seat(room, "p2", "Bob", VERIFIED.b);
    room.start();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const ended = a.sock.last("match_end");
        assert.ok(ended);
        assert.equal(ended.winner, null);
        resolve();
      }, 60);
    });
  });

  it("does not fire once both worlds are in", async () => {
    const { room, a } = playingRoom({ ...FAST, readyTimeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(a.sock.all("match_end").length, 0);
    assert.equal(room.status, "playing");
  });
});

describe("Room — leaving and disconnects", () => {
  it("settles an explicit mid-match leave as a forfeit for the opponent", () => {
    const { room, b } = playingRoom();
    room.forfeitByLeave("p1");

    const ended = b.sock.last("match_end");
    assert.equal(ended?.winner, "B");
    assert.equal(ended?.reason, "forfeit");
    assert.equal(room.size(), 1);
  });

  it("holds a disconnected player's seat instead of ending the match", () => {
    const { room, b } = playingRoom();
    const result = room.removePlayer("p1");

    assert.equal(result.wasPlaying, true);
    assert.equal(result.pendingReconnect, true);
    assert.equal(room.hasPendingReconnect(), true);
    assert.equal(b.sock.all("match_end").length, 0);
    assert.equal(room.size(), 2, "the seat is held, not freed");
  });

  it("restores a reconnecting player and cancels the forfeit", async () => {
    const room = new Room(FAST);
    seat(room, "p1", "Alice", "uuid-alice");
    const b = seat(room, "p2", "Bob", "uuid-bob");
    room.startMatchByHost("p1");
    room.markReady("p1");
    room.markReady("p2");
    room.removePlayer("p1");

    const disconnected = room.findDisconnectedByUuid("uuid-alice");
    assert.ok(disconnected, "should find the held seat by uuid");

    const fresh = new FakeWs();
    assert.ok(room.reconnectPlayer(disconnected.id, fresh.ws, null));
    room.sendReconnectSnapshot(disconnected.id);

    assert.equal(room.hasPendingReconnect(), false);
    assert.ok(fresh.last("match_start"), "reconnecting player gets the board back");

    // Past the grace window the cancelled timer must stay cancelled.
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(room.status, "playing");
    assert.equal(b.sock.all("match_end").length, 0);
  });

  it("forfeits to the opponent when the grace window expires", async () => {
    const { room, b } = playingRoom();
    room.removePlayer("p1");

    await new Promise((r) => setTimeout(r, 40));

    const ended = b.sock.last("match_end");
    assert.equal(ended?.winner, "B");
    assert.equal(ended?.reason, "disconnect");
  });

  /**
   * Regression: the grace timer used to bail on `status !== "playing"` before deleting
   * its seat. With both players gone the first timer settles the match and flips the
   * room back to "waiting", so the second timer hit that guard and left a session with
   * a dead socket in the map — size() never reached 0, emptiedAt stayed null, and the
   * reaper skipped the room for the life of the process.
   */
  it("never strands a session when both players drop", async () => {
    const { room } = playingRoom();
    room.removePlayer("p1");
    room.removePlayer("p2");

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(room.size(), 0, "both seats must be released so the room can be reaped");
  });

  it("lets the reaper collect a room both players dropped out of", async () => {
    const reg = new RoomRegistry();
    const room = reg.create(FAST);
    const a = seat(room, "p1", "Alice");
    seat(room, "p2", "Bob");
    room.startMatchByHost("p1");
    room.markReady("p1");
    room.markReady("p2");
    a.sock.drop();

    room.removePlayer("p1");
    room.removePlayer("p2");
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(room.hasPendingReconnect(), false, "no seat may still be awaiting a reconnect");
    assert.equal(reg.reapIdle(0), 1);
    assert.equal(reg.get(room.code), undefined, "the room must not outlive its players");
  });
});

describe("Room — spectators", () => {
  it("hands a spectator the current room state and board", () => {
    const { room } = playingRoom();
    const spec = new FakeWs();

    assert.equal(room.addSpectator(spec.ws), true);
    assert.ok(spec.last("room_state"));
    assert.ok(spec.last("match_start"));
  });

  it("withholds the seed from spectators but not from players", () => {
    const { room, a, b } = playingRoom();
    const spec = new FakeWs();
    room.addSpectator(spec.ws);

    // The seed regenerates the board offline, so a player watching their own match on a
    // second screen would otherwise read every mission before claiming it.
    // These are the parsed wire frames, so the 64-bit seed arrives as a decimal string.
    assert.equal(spec.last("match_start")?.seed, null);
    assert.match(String(a.sock.last("match_start")?.seed), /^-?\d+$/);
    assert.match(String(b.sock.last("match_start")?.seed), /^-?\d+$/);
  });

  it("caps the number of spectators", () => {
    const room = new Room({ ...FAST, maxSpectators: 2 });
    assert.equal(room.addSpectator(new FakeWs().ws), true);
    assert.equal(room.addSpectator(new FakeWs().ws), true);
    assert.equal(room.addSpectator(new FakeWs().ws), false);
  });

  it("relays chat and world events to everyone but the sender", () => {
    const { room, a, b } = playingRoom();
    const spec = new FakeWs();
    room.addSpectator(spec.ws);
    a.sock.clear();
    b.sock.clear();
    spec.clear();

    room.broadcastChat("p1", "hello");
    assert.equal(a.sock.all("chat_message").length, 0, "sender should not be echoed");
    assert.equal(b.sock.last("chat_message")?.text, "hello");
    assert.equal(spec.last("chat_message")?.text, "hello");

    room.broadcastWorldEvent("p1", "death", "Alice fell");
    assert.equal(b.sock.last("world_event_message")?.kind, "death");
    assert.equal(spec.last("world_event_message")?.text, "Alice fell");
  });
});

describe("RoomRegistry", () => {
  it("looks up rooms case-insensitively", () => {
    const reg = new RoomRegistry();
    const room = reg.create(FAST);
    assert.equal(reg.get(room.code.toLowerCase())?.code, room.code);
  });

  it("finds the room a uuid is currently sitting in", () => {
    const reg = new RoomRegistry();
    const room = reg.create(FAST);
    seat(room, "p1", "Alice", "uuid-alice");

    assert.equal(reg.findRoomContainingUuid("uuid-alice")?.code, room.code);
    assert.equal(reg.findRoomContainingUuid("uuid-nobody"), null);
  });

  it("lists only rooms that have not ended", () => {
    const reg = new RoomRegistry();
    const live = reg.create(FAST);
    const done = reg.create(FAST);
    done.status = "ended";

    const codes = reg.listActive().map((r) => r.code);
    assert.ok(codes.includes(live.code));
    assert.ok(!codes.includes(done.code));
  });

  it("reaps rooms that have sat empty, but spares occupied ones", () => {
    const reg = new RoomRegistry();
    const empty = reg.create(FAST);
    const occupied = reg.create(FAST);
    seat(occupied, "p1", "Alice");

    assert.equal(reg.reapIdle(0), 1);
    assert.equal(reg.get(empty.code), undefined);
    assert.equal(reg.get(occupied.code)?.code, occupied.code);
  });

  it("reaps a finished ranked room whose players are still seated", () => {
    // The idle rule can never see this one: both seats are still occupied, so
    // `idleSince()` stays null and without the ended-room rule it would live forever.
    const reg = new RoomRegistry();
    const room = reg.create(FAST, "ranked");
    const a = seat(room, "p1", "Alice", VERIFIED.a);
    seat(room, "p2", "Bob", VERIFIED.b);
    room.start();
    room.markReady("p1");
    room.markReady("p2");

    const board = boardOf(a.sock);
    for (const tile of A_WINNING_CHAIN) room.attemptClaim("p1", tile, missionFor(board, tile));

    assert.equal(room.size(), 2, "both players are still connected");
    assert.equal(room.idleSince(), null, "so the idle rule cannot apply");
    assert.equal(reg.reapIdle(0), 1);
    assert.equal(reg.get(room.code), undefined);
  });

  it("spares a ranked room that is still playing", () => {
    const reg = new RoomRegistry();
    const room = reg.create(FAST, "ranked");
    seat(room, "p1", "Alice", VERIFIED.a);
    seat(room, "p2", "Bob", VERIFIED.b);
    room.start();

    assert.equal(reg.reapIdle(0), 0);
    assert.equal(reg.get(room.code)?.code, room.code);
  });

  it("spares a room that is waiting on a reconnect", () => {
    const reg = new RoomRegistry();
    const room = reg.create(FAST);
    const a = seat(room, "p1", "Alice");
    seat(room, "p2", "Bob");
    room.startMatchByHost("p1");
    room.markReady("p1");
    room.markReady("p2");
    a.sock.drop();
    room.removePlayer("p1");

    assert.equal(reg.reapIdle(0), 0);
    assert.equal(reg.get(room.code)?.code, room.code);
  });
});
