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
  /**
   * The wire protocol this seat's client speaks. Decides whether it can be sat in a 2v2
   * room at all — see `TEAM_PROTOCOL`.
   */
  protocol: number;
  /**
   * Order of arrival on the current side, room-wide and only ever increasing.
   *
   * The lowest on a side owns that side's world. A counter rather than a timestamp
   * because two joins in the same millisecond must still have an order, and rather than
   * the map's insertion order because changing teams has to put a player at the back of
   * the queue they join.
   */
  seatedAt: number;
}

/** The client-facing view of a session — no socket, no anti-cheat bookkeeping. */
export function toPlayerInfo(s: PlayerSession): PlayerInfo {
  return { id: s.id, name: s.name, side: s.side, uuid: s.uuid, elo: s.elo };
}
