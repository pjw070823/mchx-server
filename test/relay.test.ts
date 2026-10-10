import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import { RelayHub } from "../src/relay.js";

/**
 * The relay against real sockets.
 *
 * Everything else in this suite runs on a stand-in socket, and that is not enough here:
 * what the relay does is pass frames between two connections in order and close one when
 * the other goes, and both of those are properties of the socket library as much as of
 * the code calling it.
 */
let hub: RelayHub;
let http: Server;
let url: string;

before(async () => {
  hub = new RelayHub();
  http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => hub.accept(ws));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

after(() => {
  http.closeAllConnections();
  http.close();
});

/** A client end: everything it has been sent, and how it was closed. */
class End {
  readonly ws: WebSocket;
  readonly text: string[] = [];
  readonly bytes: Buffer[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];

  constructor() {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) this.bytes.push(data as Buffer);
      else this.text.push(data.toString());
      this.wake();
    });
    this.ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.wake();
    });
    this.ws.on("error", () => {});
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  open(): Promise<void> {
    return new Promise((resolve) => this.ws.once("open", () => resolve()));
  }

  /** Wait until [done] holds, or fail the test after a second. */
  async until(done: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 1000;
    while (!done()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  hello(token: string, stream?: string): void {
    this.ws.send(JSON.stringify(stream ? { token, stream } : { token }));
  }

  received(): string {
    return Buffer.concat(this.bytes).toString();
  }
}

/** A link with both ends attached and told to go. */
async function flowing() {
  const asked: string[] = [];
  const link = hub.open((streamId) => asked.push(streamId));
  const guest = new End();
  await guest.open();
  guest.hello(link.guestToken);
  await guest.until(() => asked.length === 1, "the host to be asked");

  const host = new End();
  await host.open();
  host.hello(link.hostToken, asked[0]);
  await guest.until(() => guest.text.length === 1, "the guest's go-ahead");
  await host.until(() => host.text.length === 1, "the host's go-ahead");
  return { link, guest, host, asked };
}

describe("RelayHub", () => {
  it("asks the host to attach, then tells both ends to go", async () => {
    const { link, guest, host } = await flowing();
    assert.deepEqual(JSON.parse(guest.text[0]!), { ready: true });
    assert.deepEqual(JSON.parse(host.text[0]!), { ready: true });
    hub.close(link);
  });

  it("passes bytes both ways, in order and unaltered", async () => {
    const { link, guest, host } = await flowing();
    for (const part of ["one ", "two ", "three"]) guest.ws.send(Buffer.from(part));
    host.ws.send(Buffer.from([0, 255, 10, 13]));

    await host.until(() => host.received().length >= 13, "the guest's bytes");
    await guest.until(() => guest.bytes.length === 1, "the host's bytes");
    assert.equal(host.received(), "one two three");
    assert.deepEqual([...guest.bytes[0]!], [0, 255, 10, 13]);
    hub.close(link);
  });

  it("drops the other end when one goes", async () => {
    const { link, guest, host } = await flowing();
    guest.ws.close();
    await host.until(() => host.closed !== null, "the host's end to close");
    assert.equal(host.closed!.reason, "relay_peer_closed");
    hub.close(link);
  });

  it("takes everything down when the link is closed", async () => {
    const { link, guest, host } = await flowing();
    hub.close(link);
    await guest.until(() => guest.closed !== null, "the guest's end to close");
    await host.until(() => host.closed !== null, "the host's end to close");
    assert.equal(guest.closed!.reason, "relay_closed");
    hub.close(link); // and a second close is nothing
  });

  it("turns away a token it never issued", async () => {
    const stranger = new End();
    await stranger.open();
    stranger.hello("0".repeat(32));
    await stranger.until(() => stranger.closed !== null, "the refusal");
    assert.equal(stranger.closed!.code, 1008);
    assert.equal(stranger.closed!.reason, "relay_unknown_token");
  });

  it("turns away a token whose link has closed", async () => {
    const link = hub.open(() => {});
    hub.close(link);
    const late = new End();
    await late.open();
    late.hello(link.guestToken);
    await late.until(() => late.closed !== null, "the refusal");
    assert.equal(late.closed!.reason, "relay_unknown_token");
  });

  it("turns away a first frame that is not a hello", async () => {
    const link = hub.open(() => {});
    const binary = new End();
    await binary.open();
    binary.ws.send(Buffer.from("not a hello"));
    await binary.until(() => binary.closed !== null, "the refusal");
    assert.equal(binary.closed!.reason, "relay_bad_hello");
    hub.close(link);
  });

  it("turns away a host naming a stream nobody is waiting on", async () => {
    const link = hub.open(() => {});
    const host = new End();
    await host.open();
    host.hello(link.hostToken, "feedfacefeedface");
    await host.until(() => host.closed !== null, "the refusal");
    assert.equal(host.closed!.reason, "relay_no_stream");
    hub.close(link);
  });

  it("does not let the guest's token attach as the host", async () => {
    // The two secrets are not interchangeable: a guest presenting its own token with a
    // stream id opens a second stream, it does not answer the first.
    const asked: string[] = [];
    const link = hub.open((streamId) => asked.push(streamId));
    const first = new End();
    await first.open();
    first.hello(link.guestToken);
    await first.until(() => asked.length === 1, "the first stream");

    const second = new End();
    await second.open();
    second.hello(link.guestToken, asked[0]);
    await second.until(() => asked.length === 2, "a second stream rather than a pairing");
    assert.equal(first.text.length, 0, "nobody was told to go");
    hub.close(link);
  });

  it("stops opening streams past the cap", async () => {
    const link = hub.open(() => {});
    const ends: End[] = [];
    for (let i = 0; i < 4; i++) {
      const end = new End();
      await end.open();
      end.hello(link.guestToken);
      ends.push(end);
    }
    await ends[3]!.until(() => ends[3]!.closed !== null, "the fourth to be refused");
    assert.equal(ends[3]!.closed!.reason, "relay_too_many_streams");
    assert.equal(ends[0]!.closed, null);
    hub.close(link);
  });

  it("counts open links", () => {
    const start = hub.size;
    const link = hub.open(() => {});
    assert.equal(hub.size, start + 1);
    hub.close(link);
    assert.equal(hub.size, start);
  });
});
