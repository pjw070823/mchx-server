import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { encode } from "./protocol.js";
import type { Room, RoomRegistry } from "./room.js";

/**
 * Per-connection state. One of these exists for the life of a socket.
 *
 * `playerId` is not stable across a reconnect by design: a returning player adopts the
 * id of the seat they are restoring, so the rest of the room keeps treating them as the
 * same participant.
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
}

/** How many spectate misses before a connection is timed out from trying again. */
export const SPECTATE_FAIL_THRESHOLD = 5;
export const SPECTATE_FAIL_BACKOFF_MS = 30_000;

export function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(encode(msg));
}

export function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { type: "error", code, message });
}

/**
 * Route one validated client message.
 *
 * Split out of `index.ts` so that file is only bootstrap and the connection-level
 * security gates (rate limit, origin check, connection caps). Everything here assumes
 * the message already passed Zod validation and the rate limiter.
 */
export function handleClientMessage(
  ws: WebSocket,
  state: ConnState,
  msg: ClientMessage,
  rooms: RoomRegistry,
): void {
  switch (msg.type) {
    case "ping":
      return send(ws, { type: "pong" });

    case "create_room":
      return createRoom(ws, state, msg, rooms);

    case "join_room":
      return joinRoom(ws, state, msg, rooms);

    case "update_settings": {
      if (!state.room || state.isSpectator) return sendError(ws, "no_room", "not in a room");
      if (!state.room.updateSettings(state.playerId, msg.settings)) {
        return sendError(ws, "not_host", "only host can update settings");
      }
      return state.room.notifyJoin();
    }

    case "start_match": {
      if (!state.room || state.isSpectator) return sendError(ws, "no_room", "not in a room");
      const result = state.room.startMatchByHost(state.playerId);
      if (!result.ok) return sendError(ws, result.reason ?? "cannot_start", "cannot start match");
      return;
    }

    case "world_ready": {
      if (!state.room || state.isSpectator) return;
      return state.room.markReady(state.playerId);
    }

    case "spectate":
      return spectate(ws, state, msg, rooms);

    case "leave_room":
      return leaveRoom(ws, state, rooms);

    case "claim": {
      if (!state.room || state.isSpectator) return sendError(ws, "no_match", "not in a match");
      return state.room.attemptClaim(state.playerId, msg.tileId, msg.missionId);
    }

    case "chat": {
      if (!state.room || state.isSpectator) return sendError(ws, "no_room", "not in a room");
      const text = msg.text.trim();
      if (!text) return;
      return state.room.broadcastChat(state.playerId, text.slice(0, 256));
    }

    case "world_event": {
      if (!state.room || state.isSpectator) return sendError(ws, "no_room", "not in a room");
      const text = msg.text.trim();
      if (!text) return;
      return state.room.broadcastWorldEvent(state.playerId, msg.kind, text.slice(0, 512));
    }
  }
}

function createRoom(
  ws: WebSocket,
  state: ConnState,
  msg: Extract<ClientMessage, { type: "create_room" }>,
  rooms: RoomRegistry,
): void {
  if (state.room) return sendError(ws, "already_in_room", "leave first");
  // One account, one room. Blocks the obvious self-play setup.
  if (msg.uuid && rooms.findRoomContainingUuid(msg.uuid)) {
    return sendError(ws, "uuid_in_use", "this account is already in a room");
  }

  const room = rooms.create();
  const session = room.addPlayer(state.playerId, msg.playerName, msg.uuid ?? null, ws, state.remoteAddr);
  if (!session) {
    // Don't leak a room whose only join failed; the reaper would get it eventually.
    rooms.delete(room.code);
    return sendError(ws, "join_failed", "could not join created room");
  }
  state.room = room;
  room.notifyJoin();
}

function joinRoom(
  ws: WebSocket,
  state: ConnState,
  msg: Extract<ClientMessage, { type: "join_room" }>,
  rooms: RoomRegistry,
): void {
  if (state.room) return sendError(ws, "already_in_room", "leave first");
  const room = rooms.get(msg.roomCode);
  if (!room) return sendError(ws, "room_not_found", `no room ${msg.roomCode}`);

  if (msg.uuid) {
    // A held seat wins over a fresh join: this is a reconnect, not a new player.
    const disconnected = room.findDisconnectedByUuid(msg.uuid);
    if (disconnected && room.reconnectPlayer(disconnected.id, ws, state.remoteAddr)) {
      // Adopt the original id so the room keeps treating us as the same participant.
      state.playerId = disconnected.id;
      state.room = room;
      room.sendReconnectSnapshot(disconnected.id);
      room.notifyJoin();
      console.log(`[ws] ${state.playerId} reconnected to ${room.code}`);
      return;
    }

    const elsewhere = rooms.findRoomContainingUuid(msg.uuid);
    if (elsewhere && elsewhere !== room) {
      return sendError(ws, "uuid_in_use", "this account is already in another room");
    }
  }

  const session = room.addPlayer(state.playerId, msg.playerName, msg.uuid ?? null, ws, state.remoteAddr);
  if (!session) return sendError(ws, "room_full", "room already has 2 players");
  state.room = room;
  room.notifyJoin();
}

function spectate(
  ws: WebSocket,
  state: ConnState,
  msg: Extract<ClientMessage, { type: "spectate" }>,
  rooms: RoomRegistry,
): void {
  if (state.room) return sendError(ws, "already_in_room", "leave first");

  const now = Date.now();
  if (now < state.spectateBlockedUntil) {
    return sendError(ws, "spectate_throttled", "too many failed attempts");
  }

  const room = rooms.get(msg.roomCode);
  if (!room) {
    state.spectateFailCount++;
    if (state.spectateFailCount >= SPECTATE_FAIL_THRESHOLD) {
      state.spectateBlockedUntil = now + SPECTATE_FAIL_BACKOFF_MS;
      console.warn(`[ws] ${state.playerId} hit spectate backoff (${state.spectateFailCount} failures)`);
    }
    return sendError(ws, "room_not_found", `no room ${msg.roomCode}`);
  }

  if (!room.addSpectator(ws)) {
    return sendError(ws, "spectator_full", "room spectator slots are full");
  }
  state.room = room;
  state.isSpectator = true;
  state.spectateFailCount = 0;
}

/**
 * An explicit exit, which skips the reconnect grace entirely — the player chose this.
 * Mid-match that settles as the opponent's win before the seat is released.
 */
function leaveRoom(ws: WebSocket, state: ConnState, rooms: RoomRegistry): void {
  if (!state.room) return;

  if (state.isSpectator) {
    state.room.removeSpectator(ws);
  } else {
    if (state.room.status === "playing") {
      state.room.forfeitByLeave(state.playerId);
    } else {
      state.room.forceRemovePlayer(state.playerId);
    }
    if (state.room.size() === 0) {
      rooms.delete(state.room.code);
    } else {
      state.room.notifyJoin();
    }
  }
  state.room = null;
  state.isSpectator = false;
}
