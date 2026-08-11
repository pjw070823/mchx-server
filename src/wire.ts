import type { WebSocket } from "ws";
import type { ServerMessage } from "./protocol.js";
import { encode } from "./protocol.js";

/**
 * Sending a frame, with the one guard every caller needs.
 *
 * Its own module so `matchmaker.ts` can send without importing `handlers.ts`, which
 * imports the matchmaker back.
 */
export function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(encode(msg));
}

export function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { type: "error", code, message });
}
