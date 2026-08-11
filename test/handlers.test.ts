import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

// Sets MCHX_DB_PATH as a side effect. Must come before the dynamic imports below.
import { FAST, FakeWs, fakeConn, muteConsole, VERIFIED } from "./helpers.js";

const { RoomRegistry } = await import("../src/room.js");
const { Matchmaker } = await import("../src/matchmaker.js");
const { handleClientMessage, handleClose } = await import("../src/handlers.js");
type ServerDeps = import("../src/handlers.js").ServerDeps;

let restoreConsole: () => void;
before(() => { restoreConsole = muteConsole(); });
after(() => restoreConsole());

/**
 * The connection layer with no server behind it.
 *
 * `handleClientMessage` is a pure function of (ws, state, msg, deps) and `ConnState` is a
 * plain object, so the whole mutual-exclusion matrix is reachable without a socket
 * listening anywhere. These are security and UX rules rather than implementation
 * details — which is exactly the class of thing worth pinning.
 */
function deps(): ServerDeps & { mm: InstanceType<typeof Matchmaker> } {
  const rooms = new RoomRegistry();
  const mm = new Matchmaker({ rooms, roomConfig: FAST });
  return { rooms, matchmaker: mm, mm };
}

let seq = 0;
function verified(addr: string | null = null) {
  seq++;
  return fakeConn({
    playerId: `h${seq}`,
    uuid: `10000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    name: `H${seq}`,
    remoteAddr: addr,
  });
}

function errorFrom(sock: FakeWs): string | undefined {
  return sock.last("error")?.code as string | undefined;
}

describe("handlers — joining the queue", () => {
  it("requires the hello handshake first", () => {
    const d = deps();
    const { state, sock } = fakeConn({ protocolVersion: null });
    handleClientMessage(sock.ws, state, { type: "join_queue" }, d);
    assert.equal(errorFrom(sock), "hello_required");
    assert.equal(d.mm.size(), 0);
  });

  it("refuses a guest with a code the mod can explain", () => {
    const d = deps();
    const { state, sock } = fakeConn();
    handleClientMessage(sock.ws, state, { type: "join_queue" }, d);
    assert.equal(errorFrom(sock), "not_verified");
  });

  it("refuses someone already sitting in a room", () => {
    const d = deps();
    const { state, sock } = verified();
    state.room = d.rooms.create(FAST);
    handleClientMessage(sock.ws, state, { type: "join_queue" }, d);
    assert.equal(errorFrom(sock), "already_in_room");
  });

  it("refuses a second join and keeps the original slot", () => {
    const d = deps();
    const { state, sock } = verified();
    handleClientMessage(sock.ws, state, { type: "join_queue" }, d);
    handleClientMessage(sock.ws, state, { type: "join_queue" }, d);
    assert.equal(errorFrom(sock), "already_queued");
    assert.equal(d.mm.size(), 1);
  });
});

describe("handlers — queue and rooms are mutually exclusive", () => {
  for (const msg of [
    { type: "create_room", playerName: "H" },
    { type: "join_room", roomCode: "ABCD", playerName: "H" },
    { type: "spectate", roomCode: "ABCD" },
  ] as const) {
    it(`refuses ${msg.type} while queued, without dropping the slot`, () => {
      const d = deps();
      const { state, sock } = verified();
      handleClientMessage(sock.ws, state, { type: "join_queue" }, d);
      sock.clear();

      handleClientMessage(sock.ws, state, msg, d);
      assert.equal(errorFrom(sock), "already_queued");
      // A refusal must not cost the player their place in line.
      assert.equal(d.mm.size(), 1);
      assert.equal(state.room, null);
    });
  }

  it("refuses create_room when the same account is queued on another socket", () => {
    const d = deps();
    const first = fakeConn({ playerId: "s1", uuid: VERIFIED.a, name: "Alice" });
    const second = fakeConn({ playerId: "s2", uuid: VERIFIED.a, name: "Alice" });

    handleClientMessage(first.sock.ws, first.state, { type: "join_queue" }, d);
    handleClientMessage(second.sock.ws, second.state, { type: "create_room", playerName: "Alice" }, d);

    assert.equal(errorFrom(second.sock), "uuid_in_use");
  });
});

describe("handlers — leaving the queue", () => {
  it("says nothing when there was no slot", () => {
    // Mirrors leave_room. A cancel that races a pairing arrives after the slot is gone,
    // and that is not an error the player caused.
    const d = deps();
    const { state, sock } = verified();
    handleClientMessage(sock.ws, state, { type: "leave_queue" }, d);
    assert.equal(sock.sent.length, 0);
  });

  it("releases the slot and reports why", () => {
    const d = deps();
    const { state, sock } = verified();
    handleClientMessage(sock.ws, state, { type: "join_queue" }, d);
    sock.clear();

    handleClientMessage(sock.ws, state, { type: "leave_queue" }, d);
    assert.equal(d.mm.size(), 0);
    assert.equal(sock.last("queue_state")?.reason, "cancelled");
  });
});

describe("handlers — disconnect", () => {
  it("releases a queue slot", () => {
    // A queued connection has state.room === null, which is exactly the case the old
    // close handler early-returned on. Ordering inside handleClose is load-bearing.
    const d = deps();
    const { state, sock } = verified();
    handleClientMessage(sock.ws, state, { type: "join_queue" }, d);
    assert.equal(d.mm.size(), 1);

    handleClose(sock.ws, state, d);
    assert.equal(d.mm.size(), 0);
  });

  it("frees the account to queue again from a fresh connection", () => {
    const d = deps();
    const first = fakeConn({ playerId: "s1", uuid: VERIFIED.b, name: "Bob" });
    handleClientMessage(first.sock.ws, first.state, { type: "join_queue" }, d);
    handleClose(first.sock.ws, first.state, d);

    const second = fakeConn({ playerId: "s2", uuid: VERIFIED.b, name: "Bob" });
    handleClientMessage(second.sock.ws, second.state, { type: "join_queue" }, d);
    assert.equal(errorFrom(second.sock), undefined, "the old slot must not still hold the account");
    assert.equal(d.mm.size(), 1);
  });

  it("still deletes the room a lone player left — unchanged behaviour", () => {
    const d = deps();
    const { state, sock } = verified();
    handleClientMessage(sock.ws, state, { type: "create_room", playerName: "H" }, d);
    const code = state.room!.code;

    handleClose(sock.ws, state, d);
    assert.equal(d.rooms.get(code), undefined);
  });
});
