import type { WebSocket } from "ws";
import type { PlayerInfo, Side } from "./protocol.js";

/**
 * One seat in a room, for as long as that seat exists.
 *
 * A session outlives its socket: when a player drops mid-match the socket is dead but
 * the seat is held open for [RoomConfig.reconnectGraceMs] so they can come back to the
 * same side, ELO and claim history. That is why `disconnectedAt` and `forfeitTimer`
 * live here rather than in the connection layer.
 *
 * Lives in its own module so the match engine and settlement can name the type without
 * importing the Room that owns them.
 */
export interface PlayerSession {
  id: string;
  name: string;
  side: Side | null;
  uuid: string | null;
  ws: WebSocket;
  /** Loaded from the DB when the seat is taken; updated after a rated match settles. */
  elo: number;
  gamesPlayed: number;
  /** Set when the WS closes; cleared on reconnect. Non-null means a forfeit is pending. */
  disconnectedAt: number | null;
  /** The pending forfeit timer, cancelled on reconnect. */
  forfeitTimer: ReturnType<typeof setTimeout> | null;
  /** Remote IP at connect time. Used only for same-machine self-play detection. */
  remoteAddr: string | null;
  /** Timestamp of the last accepted claim, for the anti-rapid-fire gate. */
  lastClaimAt: number | null;
}

/** The client-facing view of a session — no socket, no anti-cheat bookkeeping. */
export function toPlayerInfo(s: PlayerSession): PlayerInfo {
  return { id: s.id, name: s.name, side: s.side, uuid: s.uuid, elo: s.elo };
}
