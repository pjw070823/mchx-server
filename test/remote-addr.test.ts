import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { remoteAddrOf } from "../src/remote-addr.js";

/**
 * Behind the proxy every player's socket has the same peer: the proxy. Read naively, the
 * whole player base is one address — nobody can be paired with anybody, and the
 * connection cap is a cap on the server. These pin what "the player's address" means.
 */
describe("remoteAddrOf", () => {
  it("reads the player's address from the proxy's header, not the proxy's own", () => {
    assert.equal(remoteAddrOf("127.0.0.1", "203.0.113.7"), "203.0.113.7");
    assert.equal(remoteAddrOf("::1", "203.0.113.7"), "203.0.113.7");
    assert.equal(remoteAddrOf("::ffff:127.0.0.1", "203.0.113.7"), "203.0.113.7");
  });

  it("tells two players behind the proxy apart", () => {
    // The whole bug: these two used to come out equal, and the queue never pairs equals.
    assert.notEqual(remoteAddrOf("127.0.0.1", "203.0.113.7"), remoteAddrOf("127.0.0.1", "198.51.100.9"));
  });

  it("ignores the header on a direct connection, where the client wrote it", () => {
    // Believing it here would let one person be as many addresses as they could type.
    assert.equal(remoteAddrOf("203.0.113.7", "198.51.100.9"), "203.0.113.7");
    assert.equal(remoteAddrOf("203.0.113.7", "127.0.0.1"), "203.0.113.7");
  });

  it("takes the last hop, which is the one our own proxy saw", () => {
    // Everything to the left of it arrived in the client's request.
    assert.equal(remoteAddrOf("127.0.0.1", "10.0.0.1, 203.0.113.7"), "203.0.113.7");
    assert.equal(remoteAddrOf("127.0.0.1", ["10.0.0.1", "203.0.113.7"]), "203.0.113.7");
  });

  it("reports a local process with no header as loopback", () => {
    assert.equal(remoteAddrOf("127.0.0.1", undefined), "127.0.0.1");
    assert.equal(remoteAddrOf("127.0.0.1", ""), "127.0.0.1");
    assert.equal(remoteAddrOf("127.0.0.1", " , "), "127.0.0.1");
  });

  it("spells one address one way, however it arrived", () => {
    // Direct on a dual-stack socket versus through the proxy: the same player.
    assert.equal(remoteAddrOf("::ffff:203.0.113.7", undefined), remoteAddrOf("127.0.0.1", "203.0.113.7"));
    assert.equal(remoteAddrOf("127.0.0.1", "2001:DB8::1"), "2001:db8::1");
  });

  it("has no address for a socket that has none", () => {
    assert.equal(remoteAddrOf(undefined, "203.0.113.7"), null);
    assert.equal(remoteAddrOf(null, undefined), null);
  });
});
