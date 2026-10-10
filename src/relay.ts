import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";

/**
 * Carries one teammate's Minecraft connection to the other's game.
 *
 * In a 2v2 match a team shares one world, and that world runs inside one teammate's game.
 * The other has to connect to it, and "connect to a friend's PC" is the thing home
 * routers exist to prevent: it needs a forwarded port, which most players cannot set up
 * and some cannot have at all. Both of them can already reach this server, though, so
 * each opens an ordinary outbound WebSocket here and the bytes are passed across.
 *
 * What crosses is the Minecraft protocol untouched — including its own encryption, which
 * the two games negotiate between themselves once the login starts. This module never
 * interprets a byte of it; it could not read the stream if it tried.
 *
 * A *link* is one team's permission to do this for the length of a match. A *stream* is
 * one TCP connection's worth of traffic inside it. The game opens a fresh connection each
 * time it joins, so a guest who drops and rejoins makes a second stream on the same link.
 */

/** The two secrets that make up a link. Each end is sent only its own. */
export interface RelayLink {
  readonly hostToken: string;
  readonly guestToken: string;
}

/**
 * How many streams one link may hold at once.
 *
 * One is the steady state. The second is the rejoin that overlaps the stream it is
 * replacing — the old one is still being torn down when the new one opens. Anything past
 * that is not a game connecting.
 */
const MAX_STREAMS_PER_LINK = 3;

/** How long a new socket has to say who it is. */
const AUTH_TIMEOUT_MS = 5_000;

/** How long a guest's stream waits for the host's end before it is given up. */
const ATTACH_TIMEOUT_MS = 10_000;

/**
 * Backpressure thresholds, in bytes queued towards one end.
 *
 * Without them a fast sender and a slow receiver — a host on fibre streaming chunks to a
 * guest on hotel wifi — would have this process buffer the difference without limit. Past
 * the high mark the sender's socket stops being read, which pushes the wait back onto its
 * TCP window and so onto the game that is producing the data.
 */
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;

interface LinkState {
  readonly hostToken: string;
  readonly guestToken: string;
  /** Ask the host's client, over its game socket, to attach to a waiting stream. */
  readonly notifyHost: (streamId: string) => void;
  /** Guest ends that have arrived and are waiting for the host's. */
  readonly waiting: Map<string, { guest: WebSocket; timer: NodeJS.Timeout }>;
  /** Both ends of every stream that is flowing. */
  readonly flowing: Set<WebSocket>;
  closed: boolean;
}

export class RelayHub {
  private readonly byToken = new Map<string, { link: LinkState; role: "host" | "guest" }>();

  /** How many links are open. For tests and for the health endpoint. */
  get size(): number {
    return this.byToken.size / 2;
  }

  /**
   * Open a link for one team.
   *
   * [notifyHost] is how a waiting stream reaches the host: the relay has no way to call a
   * client that has not connected to it yet, so the request rides the socket the host
   * already has open for the match.
   */
  open(notifyHost: (streamId: string) => void): RelayLink {
    const link: LinkState = {
      hostToken: newToken(),
      guestToken: newToken(),
      notifyHost,
      waiting: new Map(),
      flowing: new Set(),
      closed: false,
    };
    this.byToken.set(link.hostToken, { link, role: "host" });
    this.byToken.set(link.guestToken, { link, role: "guest" });
    return { hostToken: link.hostToken, guestToken: link.guestToken };
  }

  /** End a link and everything flowing through it. Safe to call twice. */
  close(handle: RelayLink): void {
    const entry = this.byToken.get(handle.hostToken);
    if (!entry) return;
    const link = entry.link;
    link.closed = true;
    this.byToken.delete(link.hostToken);
    this.byToken.delete(link.guestToken);
    for (const { guest, timer } of link.waiting.values()) {
      clearTimeout(timer);
      guest.close(1000, "relay_closed");
    }
    link.waiting.clear();
    for (const ws of link.flowing) ws.close(1000, "relay_closed");
    link.flowing.clear();
  }

  /**
   * Take a socket that arrived on the relay endpoint.
   *
   * It says who it is in its first frame rather than in the URL: the URL is written to
   * the proxy's access log, and a token there would be a token on disk.
   */
  accept(ws: WebSocket): void {
    const authTimer = setTimeout(() => ws.close(1008, "relay_auth_timeout"), AUTH_TIMEOUT_MS);
    ws.once("close", () => clearTimeout(authTimer));
    // A socket error with no listener is an uncaught exception. Closing is all there is
    // to do about one, and `close` follows it on its own.
    ws.on("error", () => {});

    ws.once("message", (raw, isBinary) => {
      clearTimeout(authTimer);
      const hello = isBinary ? null : parseHello(raw.toString());
      if (!hello) return ws.close(1008, "relay_bad_hello");

      const entry = this.byToken.get(hello.token);
      if (!entry || entry.link.closed) return ws.close(1008, "relay_unknown_token");

      if (entry.role === "guest") this.acceptGuest(entry.link, ws);
      else this.acceptHost(entry.link, ws, hello.stream);
    });
  }

  private acceptGuest(link: LinkState, guest: WebSocket): void {
    if (link.waiting.size + link.flowing.size / 2 >= MAX_STREAMS_PER_LINK) {
      return guest.close(1013, "relay_too_many_streams");
    }

    const streamId = randomBytes(8).toString("hex");
    const timer = setTimeout(() => {
      link.waiting.delete(streamId);
      guest.close(1011, "relay_host_absent");
    }, ATTACH_TIMEOUT_MS);
    link.waiting.set(streamId, { guest, timer });
    guest.once("close", () => {
      // Only if it is still the one waiting: once paired, `pump` owns the close.
      const waiting = link.waiting.get(streamId);
      if (waiting?.guest !== guest) return;
      clearTimeout(waiting.timer);
      link.waiting.delete(streamId);
    });

    link.notifyHost(streamId);
  }

  private acceptHost(link: LinkState, host: WebSocket, streamId: string | null): void {
    const waiting = streamId ? link.waiting.get(streamId) : undefined;
    if (!streamId || !waiting) return host.close(1008, "relay_no_stream");

    clearTimeout(waiting.timer);
    link.waiting.delete(streamId);
    const guest = waiting.guest;
    if (guest.readyState !== guest.OPEN) return host.close(1011, "relay_guest_gone");

    link.flowing.add(guest);
    link.flowing.add(host);
    pump(guest, host, link);
    pump(host, guest, link);

    // Each end holds its game's bytes until it hears this. The guest's game starts
    // talking the instant its connection opens, which is before the host's end exists;
    // those bytes wait in the guest's own socket buffer rather than in ours.
    const ready = JSON.stringify({ ready: true });
    guest.send(ready);
    host.send(ready);
  }
}

/** Pass everything [from] sends on to [to], and take [to] down when [from] goes. */
function pump(from: WebSocket, to: WebSocket, link: LinkState): void {
  let paused = false;

  from.on("message", (data, isBinary) => {
    // Text frames are ours, not the game's, and neither end sends one after the hello.
    if (!isBinary || to.readyState !== to.OPEN) return;

    to.send(data, { binary: true }, () => {
      if (paused && to.bufferedAmount <= LOW_WATER_BYTES) {
        paused = false;
        from.resume();
      }
    });
    if (!paused && to.bufferedAmount >= HIGH_WATER_BYTES) {
      paused = true;
      from.pause();
    }
  });

  from.once("close", () => {
    link.flowing.delete(from);
    link.flowing.delete(to);
    // 1000 whatever happened to the other end: to the game on this side it is simply a
    // connection that ended, and the game has its own words for that.
    if (to.readyState === to.OPEN || to.readyState === to.CONNECTING) to.close(1000, "relay_peer_closed");
  });
}

function parseHello(text: string): { token: string; stream: string | null } | null {
  // Bounded before parsing: this is the one frame read from a socket nobody has vouched
  // for yet.
  if (text.length > 256) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { token, stream } = parsed as { token?: unknown; stream?: unknown };
    if (typeof token !== "string" || token.length === 0) return null;
    if (stream !== undefined && typeof stream !== "string") return null;
    return { token, stream: stream ?? null };
  } catch {
    return null;
  }
}

/** 128 bits: a token is the whole of a stranger's way into somebody's world. */
function newToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The one hub this process runs.
 *
 * A module-level instance for the same reason the database handle is one: a room opens a
 * link, and the socket server routes arrivals into it, and the two meet nowhere else.
 */
export const relayHub = new RelayHub();
