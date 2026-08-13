import type { AuthChallenge, VerifiedAccount } from "./auth.js";
import type { Room } from "./room.js";

/**
 * Per-connection state. One of these exists for the life of a socket.
 *
 * `playerId` is not stable across a reconnect by design: a returning player adopts the
 * id of the seat they are restoring, so the rest of the room keeps treating them as the
 * same participant.
 *
 * Lives in its own module because both `handlers.ts` and `matchmaker.ts` need it and
 * they already point at each other — handlers calls the matchmaker, the matchmaker seats
 * players by writing `state.room`. Type-only imports erase, so there is no runtime cycle
 * today, but one value import either way would create one silently.
 */
export interface ConnState {
  playerId: string;
  room: Room | null;
  isSpectator: boolean;
  remoteAddr: string | null;
  /** Token bucket for the per-connection rate limit. */
  tokens: number;
  lastRefillAt: number;
  /** Backoff against brute-forcing the 32^4 room-code space. */
  spectateFailCount: number;
  spectateBlockedUntil: number;
  /** Set by `hello`. Null means the client hasn't introduced itself yet. */
  protocolVersion: number | null;
  /**
   * The mod build this connection reported, once it passed the version gate.
   *
   * Kept so a report of "this match behaved oddly" can be tied to a build without
   * digging through logs. Null for anything that did not report a comparable version —
   * spectators, the dev bot.
   */
  clientVersion: string | null;
  /** In-flight auth nonce. Replaced by a new `auth_begin`, cleared once used. */
  challenge: AuthChallenge | null;
  /**
   * The Mojang-confirmed account, or null for a guest.
   *
   * This is the ONLY source of a player's uuid. Anything the client says about its own
   * identity is ignored, which is the entire point of the handshake.
   */
  verified: VerifiedAccount | null;
  /**
   * `join_queue` is refused before this instant.
   *
   * Each enqueue costs one synchronous SQLite read to snapshot the rating, and the rate
   * limiter allows ~20 messages a second — so a client toggling join/leave in a loop
   * would block the event loop from a single socket. This is the only client-controlled
   * path in the queue that touches the database.
   */
  queueCooldownUntil: number;
  /** Liveness sweep: cleared before each ping, set again by the client's pong. */
  isAlive: boolean;
}
