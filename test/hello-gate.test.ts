import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

// Sets MCHX_DB_PATH as a side effect. Must come before the dynamic imports below.
import { FakeWs, fakeConn, muteConsole } from "./helpers.js";

const { RoomRegistry } = await import("../src/room.js");
const { Matchmaker } = await import("../src/matchmaker.js");
const { handleClientMessage } = await import("../src/handlers.js");
const { LATEST, MINIMUM } = await import("../src/release.js");
const { ServerMessage } = await import("../src/protocol.js");
type ServerDeps = import("../src/handlers.js").ServerDeps;

let restoreConsole: () => void;
before(() => { restoreConsole = muteConsole(); });
after(() => restoreConsole());

function deps(): ServerDeps {
  const rooms = new RoomRegistry();
  return { rooms, matchmaker: new Matchmaker({ rooms }) };
}

function hello(sock: FakeWs, state: ReturnType<typeof fakeConn>["state"], clientVersion?: string) {
  handleClientMessage(sock.ws, state, { type: "hello", protocolVersion: 2, clientVersion }, deps());
}

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
    hello(sock, state, "0.0.1");

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
    const { state, sock } = fakeConn({ protocolVersion: null });
    hello(sock, state, LATEST);
    hello(sock, state, "0.0.1");
    await settle();

    for (const frame of sock.sent) {
      const parsed = ServerMessage.safeParse(frame);
      assert.ok(parsed.success, `${frame.type as string}: ${JSON.stringify(parsed.error?.issues)}`);
    }
  });
});
