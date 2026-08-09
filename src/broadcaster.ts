import type { WebSocket } from "ws";
import type { ServerMessage } from "./protocol.js";
import { encode } from "./protocol.js";
import type { PlayerSession } from "./session.js";

/**
 * Fan-out for one room: who receives a message, and the wire logging that goes with it.
 *
 * Room used to hand-roll this at every call site — iterate players, iterate spectators,
 * check `readyState`, log a truncated payload — which is how "relay to everyone except
 * the sender" ended up written twice with subtly different loops.
 *
 * Holds live references to the room's own collections, so seats added or dropped after
 * construction are picked up automatically.
 */
export class RoomBroadcaster {
  constructor(
    private readonly code: string,
    private readonly players: ReadonlyMap<string, PlayerSession>,
    private readonly spectators: ReadonlySet<WebSocket>,
  ) {}

  /** Send to one socket, skipping anything not currently open. */
  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    const payload = encode(msg);
    console.log(`[ws] [${this.code}] -> ${payload.slice(0, 200)}`);
    ws.send(payload);
  }

  /** Every player and every spectator. */
  toEveryone(msg: ServerMessage): void {
    for (const p of this.players.values()) this.send(p.ws, msg);
    for (const sp of this.spectators) this.send(sp, msg);
  }

  /**
   * Everyone except one player — used for relays, where the sender's own client has
   * already displayed the message locally and would otherwise see it twice.
   */
  toEveryoneExcept(playerId: string, msg: ServerMessage): void {
    for (const [id, p] of this.players) {
      if (id !== playerId) this.send(p.ws, msg);
    }
    for (const sp of this.spectators) this.send(sp, msg);
  }
}
