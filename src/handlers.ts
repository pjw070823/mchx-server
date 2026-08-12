import type { WebSocket } from "ws";
import type { ClientMessage } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { RoomRegistry } from "./room.js";
import type { ConnState } from "./conn-state.js";
import type { Matchmaker } from "./matchmaker.js";
import { QUEUE_ERROR_TEXT } from "./matchmaker.js";
import { send, sendError } from "./wire.js";
import { issueChallenge, verifyChallenge } from "./auth.js";

// Re-exported so existing importers (index.ts, tests) don't care that these moved.
export type { ConnState } from "./conn-state.js";
export { send, sendError } from "./wire.js";

/** Everything a message handler is allowed to reach. */
export interface ServerDeps {
  readonly rooms: RoomRegistry;
  readonly matchmaker: Matchmaker;
}

/**
 * Oldest protocol this build still speaks. Raise it when an old client would do
 * something worse than miss a feature.
 */
export const MIN_SUPPORTED_PROTOCOL = 1;

/** How many spectate misses before a connection is timed out from trying again. */
export const SPECTATE_FAIL_THRESHOLD = 5;
export const SPECTATE_FAIL_BACKOFF_MS = 30_000;

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
  deps: ServerDeps,
): void {
  const { rooms, matchmaker } = deps;
  switch (msg.type) {
    case "ping":
      return send(ws, { type: "pong" });

    case "hello":
      return hello(ws, state, msg);

    case "auth_begin": {
      state.challenge = issueChallenge();
      return send(ws, { type: "auth_challenge", serverId: state.challenge.serverId });
    }

    case "auth_verify":
      // Talks to Mojang, so it can't block the message loop. Failures are reported to
      // the client as an unauthenticated result rather than thrown away.
      void authVerify(ws, state, msg.playerName);
      return;

    case "create_room":
      return createRoom(ws, state, msg, deps);

    case "join_room":
      return joinRoom(ws, state, msg, deps);

    case "join_queue": {
      if (!requireHello(ws, state)) return;
      // enqueue() is the sole authority on who may queue — replicating any of its
      // checks here would give the rules a second place to drift.
      const result = matchmaker.enqueue(state, ws);
      if (!result.ok) return sendError(ws, result.code, QUEUE_ERROR_TEXT[result.code]);
      return; // enqueue() already sent the opening queue_state
    }

    case "leave_queue":
      // Silent when not queued, mirroring `leave_room`. A cancel that races a pairing
      // arrives after the slot is gone, and that is not an error the player caused.
      matchmaker.dequeue(state, "cancelled");
      return;

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
      return spectate(ws, state, msg, deps);

    case "leave_room":
      return leaveRoom(ws, state, rooms);

    case "forfeit": {
      if (!state.room || state.isSpectator) return sendError(ws, "no_match", "not in a match");
      // Silent when there is no live match — a second press, or one that raced the
      // opponent's win, is not something the player did wrong.
      state.room.forfeitMatch(state.playerId);
      return;
    }

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

/**
 * Tear down whatever this connection was holding.
 *
 * Lives here rather than inline in `index.ts` so the invariants it enforces — a seat is
 * released, a finished room with nobody watching is deleted — are reachable from a test
 * without standing up a WebSocket server.
 */
export function handleClose(ws: WebSocket, state: ConnState, deps: ServerDeps): void {
  // BEFORE the `state.room` check below: a queued connection has no room by
  // construction, so putting this second would leak every slot on disconnect.
  deps.matchmaker.dequeue(state, "disconnected");

  const rooms = deps.rooms;
  if (!state.room) return;

  if (state.isSpectator) {
    state.room.removeSpectator(ws);
    // A finished room with nobody left in it has nothing more to show.
    if (state.room.size() === 0 && state.room.status === "ended") {
      rooms.delete(state.room.code);
    }
    return;
  }

  const { wasPlaying, pendingReconnect } = state.room.removePlayer(state.playerId);
  if (state.room.size() === 0 && !wasPlaying && !pendingReconnect) {
    rooms.delete(state.room.code);
  } else if (!pendingReconnect) {
    state.room.notifyJoin();
  }
}

/**
 * Version handshake. A client whose protocol we don't speak is told so and disconnected,
 * rather than being allowed to fail confusingly somewhere later in a match.
 */
function hello(
  ws: WebSocket,
  state: ConnState,
  msg: Extract<ClientMessage, { type: "hello" }>,
): void {
  const version = msg.protocolVersion;
  if (version < MIN_SUPPORTED_PROTOCOL || version > PROTOCOL_VERSION) {
    console.warn(`[ws] ${state.playerId} unsupported protocol ${version}`);
    sendError(
      ws,
      "protocol_mismatch",
      `이 서버는 프로토콜 ${MIN_SUPPORTED_PROTOCOL}~${PROTOCOL_VERSION}만 지원합니다 (클라이언트: ${version}). 모드를 업데이트해 주세요.`,
    );
    ws.close(1008, "protocol_mismatch");
    return;
  }
  state.protocolVersion = version;
  console.log(`[ws] ${state.playerId} hello v${version}${msg.clientVersion ? ` (${msg.clientVersion})` : ""}`);
  send(ws, { type: "hello_ok", protocolVersion: PROTOCOL_VERSION });
}

/**
 * Second half of the account handshake: ask Mojang whether this name joined under the
 * nonce we issued. The challenge is consumed either way, so a failed attempt can't be
 * retried against the same nonce.
 */
async function authVerify(ws: WebSocket, state: ConnState, playerName: string): Promise<void> {
  const challenge = state.challenge;
  state.challenge = null;

  const outcome = await verifyChallenge(challenge, playerName);
  if (!outcome.ok) {
    console.log(`[auth] ${state.playerId} not verified: ${outcome.reason}`);
    state.verified = null;
    return send(ws, { type: "auth_result", authenticated: false, uuid: null, name: null, reason: outcome.reason });
  }

  state.verified = outcome.account;
  console.log(`[auth] ${state.playerId} verified as ${outcome.account.name} (${outcome.account.uuid})`);
  send(ws, {
    type: "auth_result",
    authenticated: true,
    uuid: outcome.account.uuid,
    name: outcome.account.name,
    reason: null,
  });
}

/**
 * Guard for anything that seats a player. Spectating is deliberately exempt: it is
 * read-only, and an out-of-date web page shouldn't be locked out of watching.
 */
function requireHello(ws: WebSocket, state: ConnState): boolean {
  if (state.protocolVersion !== null) return true;
  sendError(ws, "hello_required", "send `hello` before joining a room");
  return false;
}

function createRoom(
  ws: WebSocket,
  state: ConnState,
  msg: Extract<ClientMessage, { type: "create_room" }>,
  deps: ServerDeps,
): void {
  const { rooms, matchmaker } = deps;
  if (!requireHello(ws, state)) return;
  if (state.room) return sendError(ws, "already_in_room", "leave first");
  if (matchmaker.isQueued(state)) {
    return sendError(ws, "already_queued", "cancel the queue first");
  }

  const { uuid, name } = identityOf(state, msg.playerName);
  // One account, one room — and one account cannot be queued and in a room at once.
  if (uuid && (rooms.findRoomContainingUuid(uuid) || matchmaker.hasUuid(uuid))) {
    return sendError(ws, "uuid_in_use", "this account is already queued or in a room");
  }

  const room = rooms.create();
  const session = room.addPlayer(state.playerId, name, uuid, ws, state.remoteAddr);
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
  deps: ServerDeps,
): void {
  const { rooms, matchmaker } = deps;
  if (!requireHello(ws, state)) return;
  if (state.room) return sendError(ws, "already_in_room", "leave first");
  if (matchmaker.isQueued(state)) {
    return sendError(ws, "already_queued", "cancel the queue first");
  }
  const room = rooms.get(msg.roomCode);
  if (!room) return sendError(ws, "room_not_found", `no room ${msg.roomCode}`);

  const { uuid, name } = identityOf(state, msg.playerName);

  // Reconnects are keyed on the verified account, so an unauthenticated client can no
  // longer claim someone else's held seat by guessing their uuid.
  if (uuid) {
    const disconnected = room.findDisconnectedByUuid(uuid);
    if (disconnected && room.reconnectPlayer(disconnected.id, ws, state.remoteAddr)) {
      // Adopt the original id so the room keeps treating us as the same participant.
      state.playerId = disconnected.id;
      state.room = room;
      room.sendReconnectSnapshot(disconnected.id);
      room.notifyJoin();
      console.log(`[ws] ${state.playerId} reconnected to ${room.code}`);
      return;
    }

    const elsewhere = rooms.findRoomContainingUuid(uuid);
    if ((elsewhere && elsewhere !== room) || matchmaker.hasUuid(uuid)) {
      return sendError(ws, "uuid_in_use", "this account is already queued or in another room");
    }
  }

  const session = room.addPlayer(state.playerId, name, uuid, ws, state.remoteAddr);
  if (!session) return sendError(ws, "room_full", "room already has 2 players");
  state.room = room;
  room.notifyJoin();
}

/**
 * Who this connection is, as far as the server is concerned.
 *
 * A verified account supplies both uuid and display name — using Mojang's name too means
 * a player can't sit in the lobby under someone else's handle. Without verification the
 * client is a guest: no uuid, so no rating, no persistence, no reconnect claim.
 */
function identityOf(state: ConnState, claimedName: string): { uuid: string | null; name: string } {
  if (state.verified) return { uuid: state.verified.uuid, name: state.verified.name };
  return { uuid: null, name: claimedName };
}

function spectate(
  ws: WebSocket,
  state: ConnState,
  msg: Extract<ClientMessage, { type: "spectate" }>,
  deps: ServerDeps,
): void {
  const { rooms, matchmaker } = deps;
  if (state.room) return sendError(ws, "already_in_room", "leave first");
  // Watching from the queue would mean holding a slot you cannot be pulled out of
  // cleanly — a pairing would seat a connection that is already a spectator.
  if (matchmaker.isQueued(state)) {
    return sendError(ws, "already_queued", "cancel the queue first");
  }

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
