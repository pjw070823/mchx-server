import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

// Sets MCHX_DB_PATH as a side effect. Must come before the dynamic imports below.
import { FAST, FakeWs, fakeConn, muteConsole, VERIFIED } from "./helpers.js";

const { RoomRegistry } = await import("../src/room.js");
const { Matchmaker, eloWindow, QUEUE_TUNING } = await import("../src/matchmaker.js");
const { RANKED_SETTINGS } = await import("../src/settings-policy.js");
const { getOrCreatePlayer, applyMatchResult } = await import("../src/db.js");

let restoreConsole: () => void;
before(() => { restoreConsole = muteConsole(); });
after(() => restoreConsole());

/** A matchmaker with a clock the test drives by hand. */
function harness(startAt = 1_000_000) {
  let clock = startAt;
  const rooms = new RoomRegistry();
  const mm = new Matchmaker({ rooms, roomConfig: FAST, now: () => clock });
  return {
    rooms,
    mm,
    advance(ms: number) { clock += ms; },
    at() { return clock; },
  };
}

let seq = 0;
/** A verified connection with a distinct account and address unless told otherwise. */
function player(opts: { uuid?: string; elo?: number; addr?: string | null } = {}) {
  seq++;
  const uuid = opts.uuid ?? `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  const name = `P${seq}`;
  if (opts.elo != null) {
    getOrCreatePlayer(uuid, name);
    // applyMatchResult is the only writer of `elo`; outcome 0 leaves the record a draw.
    applyMatchResult(uuid, opts.elo, 0);
  }
  return fakeConn({
    playerId: `c${seq}`,
    uuid,
    name,
    remoteAddr: opts.addr === undefined ? `10.0.0.${seq}` : opts.addr,
  });
}

describe("Matchmaker — who may queue", () => {
  it("refuses a guest", () => {
    // Ranked means rated, and settlement.ts force-unrates a match missing a uuid — so a
    // queued guest would produce a "ranked" match that moves nobody's rating.
    const { mm } = harness();
    const { state, sock } = fakeConn();
    assert.deepEqual(mm.enqueue(state, sock.ws), { ok: false, code: "not_verified" });
    assert.equal(mm.size(), 0);
  });

  it("refuses a second slot on the same connection", () => {
    const { mm } = harness();
    const { state, sock } = player();
    assert.deepEqual(mm.enqueue(state, sock.ws), { ok: true });
    assert.deepEqual(mm.enqueue(state, sock.ws), { ok: false, code: "already_queued" });
    assert.equal(mm.size(), 1);
  });

  it("refuses the same account arriving on a second socket", () => {
    const { mm } = harness();
    const shared = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const one = player({ uuid: shared });
    const two = player({ uuid: shared });
    mm.enqueue(one.state, one.sock.ws);
    assert.deepEqual(mm.enqueue(two.state, two.sock.ws), { ok: false, code: "uuid_in_use" });
  });

  it("refuses an account that is already sitting in a room", () => {
    const { mm, rooms } = harness();
    const room = rooms.create(FAST);
    room.addPlayer("p1", "Alice", VERIFIED.a, new FakeWs().ws);

    const { state, sock } = player({ uuid: VERIFIED.a });
    assert.deepEqual(mm.enqueue(state, sock.ws), { ok: false, code: "uuid_in_use" });
  });

  it("refuses a connection that is already in a room", () => {
    const { mm, rooms } = harness();
    const { state, sock } = player();
    state.room = rooms.create(FAST);
    assert.deepEqual(mm.enqueue(state, sock.ws), { ok: false, code: "already_in_room" });
  });

  it("rate-limits re-entry after leaving", () => {
    // Each enqueue costs one synchronous SQLite read, and the rate limiter allows ~20
    // messages a second — a join/leave loop would block the event loop from one socket.
    const h = harness();
    const { state, sock } = player();
    h.mm.enqueue(state, sock.ws);
    h.mm.dequeue(state, "cancelled");
    assert.deepEqual(h.mm.enqueue(state, sock.ws), { ok: false, code: "queue_cooldown" });

    h.advance(1_001);
    assert.deepEqual(h.mm.enqueue(state, sock.ws), { ok: true });
  });
});

describe("Matchmaker — queue_state", () => {
  it("reports the rating it will actually search on, immediately", () => {
    const { mm } = harness();
    const { state, sock } = player({ elo: 742 });
    mm.enqueue(state, sock.ws);

    const frame = sock.last("queue_state");
    assert.equal(frame?.queued, true);
    assert.equal(frame?.elo, 742);
    assert.equal(frame?.waitingMs, 0);
    assert.equal(frame?.window, QUEUE_TUNING.initialWindow);
  });

  it("freezes the rating snapshot for the life of the slot", () => {
    // tick() must never touch the database — node:sqlite is synchronous, so a per-tick
    // query would block the event loop for everyone.
    const h = harness();
    const { state, sock } = player({ elo: 500 });
    h.mm.enqueue(state, sock.ws);

    applyMatchResult(state.verified!.uuid, 1_200, 1);
    h.advance(QUEUE_TUNING.pushIntervalMs + 1);
    h.mm.tick();

    assert.equal(sock.last("queue_state")?.elo, 500);
  });

  it("is idempotent on leave and says why exactly once", () => {
    const { mm } = harness();
    const { state, sock } = player();
    mm.enqueue(state, sock.ws);
    sock.clear();

    assert.equal(mm.dequeue(state, "cancelled"), true);
    assert.equal(mm.dequeue(state, "cancelled"), false);

    const frames = sock.all("queue_state");
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.queued, false);
    assert.equal(frames[0]?.reason, "cancelled");
  });
});

describe("Matchmaker — pairing", () => {
  it("pairs two equal ratings on the first tick and starts the match", () => {
    const h = harness();
    const a = player({ elo: 500 });
    const b = player({ elo: 500 });
    h.mm.enqueue(a.state, a.sock.ws);
    h.mm.enqueue(b.state, b.sock.ws);

    const { matched } = h.mm.tick();
    assert.equal(matched.length, 1);

    const room = matched[0]!.room;
    assert.equal(room.origin, "ranked");
    assert.equal(room.status, "playing");
    assert.equal(a.state.room, room, "the matchmaker seats the connection itself");
    assert.equal(b.state.room, room);
    assert.equal(h.mm.size(), 0);
  });

  it("sends room_state before match_start", () => {
    // MatchFlow.onMatchStart reads MatchState.roomCode, which only arrives via
    // room_state. Reversed, the client logs "cannot create world" and hangs on black.
    const h = harness();
    const a = player({ elo: 500 });
    const b = player({ elo: 500 });
    h.mm.enqueue(a.state, a.sock.ws);
    h.mm.enqueue(b.state, b.sock.ws);
    h.mm.tick();

    for (const sock of [a.sock, b.sock]) {
      const roomState = sock.indexOf("room_state");
      const matchStart = sock.indexOf("match_start");
      assert.ok(roomState >= 0 && matchStart >= 0, "both frames must be sent");
      assert.ok(roomState < matchStart, "room_state must arrive first");
    }
  });

  it("builds a hostless room on the fixed ladder preset", () => {
    const h = harness();
    const a = player({ elo: 500 });
    const b = player({ elo: 500 });
    h.mm.enqueue(a.state, a.sock.ws);
    h.mm.enqueue(b.state, b.sock.ws);
    const room = h.mm.tick().matched[0]!.room;

    assert.equal(room.hostId, null);
    assert.deepEqual(room.settings, RANKED_SETTINGS);
    assert.equal(room.startMatchByHost(a.state.playerId).reason, "not_host");
    assert.equal(room.updateSettings(a.state.playerId, { saturation: false }), false);
  });

  it("tells both players the slot ended because they were matched", () => {
    const h = harness();
    const a = player({ elo: 500 });
    const b = player({ elo: 500 });
    h.mm.enqueue(a.state, a.sock.ws);
    h.mm.enqueue(b.state, b.sock.ws);
    h.mm.tick();

    for (const sock of [a.sock, b.sock]) {
      const last = sock.all("queue_state").at(-1);
      assert.equal(last?.queued, false);
      assert.equal(last?.reason, "matched");
    }
  });
});

describe("Matchmaker — the ELO window", () => {
  it("widens with the wait", () => {
    assert.equal(eloWindow(0), QUEUE_TUNING.initialWindow);
    assert.equal(eloWindow(10_000), 300);
    assert.equal(eloWindow(15_000), 400);
    assert.equal(eloWindow(10 * 60_000), QUEUE_TUNING.maxWindow, "and stops at the cap");
  });

  it("holds a mismatched pair apart until the window reaches them", () => {
    const h = harness();
    const a = player({ elo: 500 });
    const b = player({ elo: 800 });
    h.mm.enqueue(a.state, a.sock.ws);
    h.mm.enqueue(b.state, b.sock.ws);

    assert.equal(h.mm.tick().matched.length, 0, "300 apart is too far at t=0");
    h.advance(10_000);
    assert.equal(h.mm.tick().matched.length, 1);
  });

  it("uses the stricter of the two windows", () => {
    // Otherwise someone who waited five minutes drags a fresh arrival into a blowout.
    const h = harness();
    const waiter = player({ elo: 500 });
    h.mm.enqueue(waiter.state, waiter.sock.ws);
    h.advance(30_000); // waiter's own window is now ±700

    const fresh = player({ elo: 1_100 });
    h.mm.enqueue(fresh.state, fresh.sock.ws);
    assert.equal(h.mm.tick().matched.length, 0, "the newcomer's ±100 governs");
  });

  it("pairs a long waiter with anyone once patience runs out", () => {
    // The stricter-window rule alone would strand exactly the person we most want to
    // serve: alone for minutes, and every arrival's window is still narrow.
    const h = harness();
    const waiter = player({ elo: 500 });
    h.mm.enqueue(waiter.state, waiter.sock.ws);
    h.advance(QUEUE_TUNING.openToAnyoneAfterMs + 1);

    const fresh = player({ elo: 3_500 });
    h.mm.enqueue(fresh.state, fresh.sock.ws);
    assert.equal(h.mm.tick().matched.length, 1);
  });

  it("serves the longest waiter first", () => {
    const h = harness();
    const first = player({ elo: 500 });
    h.mm.enqueue(first.state, first.sock.ws);
    h.advance(5_000);
    const second = player({ elo: 500 });
    h.mm.enqueue(second.state, second.sock.ws);
    h.advance(5_000);
    const third = player({ elo: 500 });
    h.mm.enqueue(third.state, third.sock.ws);

    const { matched } = h.mm.tick();
    assert.equal(matched.length, 1);
    const ids = [matched[0]!.aId, matched[0]!.bId];
    assert.ok(ids.includes(first.state.playerId), "the oldest slot must be served");
    assert.ok(ids.includes(second.state.playerId));
    assert.equal(third.state.room, null, "the newest waits for the next arrival");
  });
});

describe("Matchmaker — abuse and liveness", () => {
  it("never pairs two players behind one address", () => {
    // settlement.ts would force-unrate this after the fact, which is worse: they would
    // play a ranked match and get nothing for it.
    const h = harness();
    const a = player({ elo: 500, addr: "203.0.113.7" });
    const b = player({ elo: 500, addr: "203.0.113.7" });
    h.mm.enqueue(a.state, a.sock.ws);
    h.mm.enqueue(b.state, b.sock.ws);

    assert.equal(h.mm.tick().matched.length, 0);
    h.advance(QUEUE_TUNING.openToAnyoneAfterMs + 1);
    assert.equal(h.mm.tick().matched.length, 0, "patience does not relax this one");
  });

  it("relaxes verification and the address rule in dev mode", () => {
    // Without this switch, local testing is impossible: two clients on one machine
    // share an address, and dev bots have no Mojang account.
    const rooms = new RoomRegistry();
    let clock = 1_000_000;
    const mm = new Matchmaker({ rooms, roomConfig: FAST, now: () => clock, devMode: true });

    const a = fakeConn({ playerId: "d1", remoteAddr: "127.0.0.1" });
    const b = fakeConn({ playerId: "d2", remoteAddr: "127.0.0.1" });
    assert.deepEqual(mm.enqueue(a.state, a.sock.ws), { ok: true }, "guests may queue");
    assert.deepEqual(mm.enqueue(b.state, b.sock.ws), { ok: true });

    const { matched } = mm.tick();
    assert.equal(matched.length, 1, "and share an address");
    clock += 0;
  });

  it("drops an entry whose socket has gone", () => {
    const h = harness();
    const a = player({ elo: 500 });
    const b = player({ elo: 500 });
    h.mm.enqueue(a.state, a.sock.ws);
    h.mm.enqueue(b.state, b.sock.ws);
    a.sock.drop();

    const { matched } = h.mm.tick();
    assert.equal(matched.length, 0, "a dead socket must not be handed a real opponent");
    assert.equal(h.mm.size(), 1);
  });
});
