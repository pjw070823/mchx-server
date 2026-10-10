import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

// Sets MCHX_DB_PATH as a side effect. Must come before the dynamic imports below.
import { FakeWs, fakeConn, muteConsole } from "./helpers.js";

const { RoomRegistry } = await import("../src/room.js");
const { Matchmaker } = await import("../src/matchmaker.js");
const { handleClientMessage } = await import("../src/handlers.js");
const { LATEST, MINIMUM, MINECRAFT_FLOOR, MINECRAFT_MOVED_NOTICE } = await import("../src/release.js");
const { ServerMessage } = await import("../src/protocol.js");
type ServerDeps = import("../src/handlers.js").ServerDeps;

let restoreConsole: () => void;
before(() => { restoreConsole = muteConsole(); });
after(() => restoreConsole());

function deps(versionGates?: ServerDeps["versionGates"]): ServerDeps {
  const rooms = new RoomRegistry();
  return { rooms, matchmaker: new Matchmaker({ rooms }), versionGates };
}

function hello(
  sock: FakeWs,
  state: ReturnType<typeof fakeConn>["state"],
  clientVersion?: string,
  d: ServerDeps = deps(),
) {
  handleClientMessage(sock.ws, state, { type: "hello", protocolVersion: 2, clientVersion }, d);
}

/**
 * Deps with the Minecraft floor lowered out of the way.
 *
 * While MINIMUM sits below MINECRAFT_FLOOR, every build the minimum would refuse is
 * refused by the floor first, and `update_required` has nobody to be sent to. It is still
 * the path a future MINIMUM bump will switch on, so it is still tested.
 */
const belowMinimumOnly = () => deps({ minecraftFloor: "0.0.0" });

/** The close is deferred a beat so the notice lands first; give it that beat. */
const settle = () => new Promise((r) => setTimeout(r, 400));

describe("the hello build gate", () => {
  it("admits a current build and tells it what the newest one is", () => {
    const { state, sock } = fakeConn({ protocolVersion: null });
    hello(sock, state, LATEST);

    const ok = sock.last("hello_ok");
    assert.ok(ok, "expected hello_ok");
    assert.equal((ok.release as { version: string }).version, LATEST);
    assert.equal(sock.closes.length, 0);
    assert.equal(state.clientVersion, LATEST);
  });

  it("refuses a build below the minimum, and says where to get one", async () => {
    const { state, sock } = fakeConn({ protocolVersion: null });
    hello(sock, state, "0.0.1", belowMinimumOnly());

    const notice = sock.last("update_required");
    assert.ok(notice, "expected update_required");
    assert.equal(notice.yourVersion, "0.0.1");
    assert.equal((notice.release as { minimum: string }).minimum, MINIMUM);

    // The refused connection never becomes a participant.
    assert.equal(state.protocolVersion, null);
    assert.equal(sock.last("hello_ok"), undefined);

    // The notice goes out first and the close follows, never the other way round —
    // a socket that closes in the same tick loses the message.
    assert.equal(sock.closes.length, 0, "closed before the client could read the notice");
    await settle();
    assert.equal(sock.closes.at(0)?.code, 1008);
  });

  it("lets a build it cannot parse through, rather than refusing on a shrug", () => {
    // `unknown` is what the mod reports when Fabric metadata is unreadable, and the dev
    // bot reports its own name. Neither should be lockable out by a version comparison.
    for (const v of ["unknown", "dev-bot", undefined]) {
      const { state, sock } = fakeConn({ protocolVersion: null });
      hello(sock, state, v);
      assert.ok(sock.last("hello_ok"), `expected hello_ok for ${String(v)}`);
      assert.equal(state.clientVersion, v ?? null);
    }
  });

  it("does not tell a newer-than-released build to update", () => {
    const { state, sock } = fakeConn({ protocolVersion: null });
    hello(sock, state, "99.0.0");
    assert.ok(sock.last("hello_ok"));
    assert.equal(sock.closes.length, 0);
  });

  it("emits frames the client's own schema accepts", async () => {
    // The mod parses these; a field added here and not there fails at runtime, not build
    // time. Parsing our own output against the shared schema is the cheapest guard.
    // One connection per outcome: a refused connection is answered nothing further.
    const admitted = fakeConn({ protocolVersion: null });
    const tooOld = fakeConn({ protocolVersion: null });
    const moved = fakeConn({ protocolVersion: null });
    hello(admitted.sock, admitted.state, LATEST);
    hello(tooOld.sock, tooOld.state, "0.0.1", belowMinimumOnly());
    hello(moved.sock, moved.state, "0.1.15");
    await settle();

    assert.ok(admitted.sock.last("hello_ok"));
    assert.ok(tooOld.sock.last("update_required"));
    assert.ok(moved.sock.last("error"));
    for (const frame of [...admitted.sock.sent, ...tooOld.sock.sent, ...moved.sock.sent]) {
      const parsed = ServerMessage.safeParse(frame);
      assert.ok(parsed.success, `${frame.type as string}: ${JSON.stringify(parsed.error?.issues)}`);
    }
  });
});

/**
 * Builds from before the move to a newer Minecraft.
 *
 * They cannot be updated from here — the mod does not choose which Minecraft it runs in —
 * so they are told, in the one error message every installed build prints as written.
 */
describe("the hello Minecraft gate", () => {
  it("tells a build for the old Minecraft to reinstall, in words it will display", async () => {
    const { state, sock } = fakeConn({ protocolVersion: null });
    hello(sock, state, "0.1.15");

    const error = sock.last("error");
    assert.equal(error?.code, "protocol_mismatch", "the only code old builds print verbatim");
    assert.equal(error?.message, MINECRAFT_MOVED_NOTICE);
    assert.equal(sock.last("hello_ok"), undefined);
    assert.equal(state.protocolVersion, null);

    assert.equal(sock.closes.length, 0, "closed before the client could read the notice");
    await settle();
    assert.equal(sock.closes.at(0)?.code, 1008);
  });

  it("never offers such a build the download, however old it is", () => {
    // 0.0.1 is below MINIMUM as well. Sent `update_required` it would install a jar built
    // for a Minecraft it is not running, and the game would stop launching.
    const { state, sock } = fakeConn({ protocolVersion: null });
    hello(sock, state, "0.0.1");
    assert.equal(sock.last("update_required"), undefined);
    assert.equal(sock.last("error")?.message, MINECRAFT_MOVED_NOTICE);
  });

  it("admits the first build for the new Minecraft", () => {
    const { state, sock } = fakeConn({ protocolVersion: null });
    hello(sock, state, MINECRAFT_FLOOR);
    assert.ok(sock.last("hello_ok"));
    assert.equal(sock.last("error"), undefined);
  });

  it("answers nothing more on a connection it has refused", () => {
    // The mod queues `auth_begin` behind `hello`. A challenge in reply sends it to Mojang
    // and back, by which time the socket has closed — so it reconnects, is refused, and
    // is challenged again, for as long as the game stays open.
    const { state, sock } = fakeConn({ protocolVersion: null });
    const d = deps();
    hello(sock, state, "0.1.15", d);
    const sentAfterRefusal = sock.sent.length;

    handleClientMessage(sock.ws, state, { type: "auth_begin" }, d);
    handleClientMessage(sock.ws, state, { type: "create_room", playerName: "Alice" }, d);
    handleClientMessage(sock.ws, state, { type: "ping" }, d);

    assert.equal(sock.sent.length, sentAfterRefusal);
    assert.equal(sock.last("auth_challenge"), undefined);
    assert.equal(state.room, null);
  });

  it("fits on the one line it is given", () => {
    // Drawn centred and unwrapped on the old builds' match-start screen.
    assert.ok(!MINECRAFT_MOVED_NOTICE.includes("\n"));
    assert.ok(MINECRAFT_MOVED_NOTICE.length <= 60, `${MINECRAFT_MOVED_NOTICE.length} characters`);
  });
});
