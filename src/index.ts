import { createServer, type IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { nanoid } from "nanoid";
import { decode, encode, type ServerMessage } from "./protocol.js";
import { Room, RoomRegistry } from "./room.js";
import { ALL_MISSIONS } from "./missions.js";
import {
  getAllMatches,
  getLeaderboard,
  getMatchById,
  getMatchCount,
  getMatchesByPlayerName,
  getPlayer,
  getRecentMatches,
  searchPlayersByName,
} from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const SPECTATOR_PORT = Number(process.env.SPECTATOR_PORT ?? 80);
const PUBLIC_DIR = resolve(__dirname, "../public");

// --- Security knobs ----------------------------------------------------------

/** H6: cap WebSocket frame size. The biggest legitimate client message is
 *  a chat (256B) or world_event (512B); 8 KiB is generous headroom for JSON
 *  overhead. Anything larger is almost certainly an attack. */
const MAX_WS_PAYLOAD = 8 * 1024;

/** H4: per-IP concurrent WS connection cap. Two players + a few spectators
 *  on the same NAT fits comfortably under 10. Any more = abuse. */
const MAX_CONNS_PER_IP = 10;

/** H2: per-connection token bucket. Allow short bursts (cap) but cap sustained
 *  rate (refill). Default cost is 1 token per message. */
const RATE_BUCKET_CAP = 60;
const RATE_BUCKET_REFILL_PER_SEC = 20;

/** M3: how many spectate failures before a connection is temporarily blocked
 *  from further spectate attempts (room-code brute force). */
const SPECTATE_FAIL_THRESHOLD = 5;
const SPECTATE_FAIL_BACKOFF_MS = 30_000;

/** UUID validation regex (M1). */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const rooms = new RoomRegistry();

/**
 * Idle TTL for empty rooms. If a room has had no player sessions for this long
 * (and no pending grace-period reconnect), it's reaped. The normal close-handler
 * path already deletes empty rooms instantly; this is the safety net for edge
 * cases where that path didn't run (create+addPlayer failure, forfeit-timer
 * stranded sessions, etc.). Short enough that idle rooms don't clutter
 * `/api/rooms`; long enough that a fast disconnect-reconnect doesn't lose state.
 */
const EMPTY_ROOM_TTL_MS = 60_000;

setInterval(() => {
  const reaped = rooms.reapIdle(EMPTY_ROOM_TTL_MS);
  if (reaped > 0) console.log(`[rooms] reaped ${reaped} idle room(s)`);
}, 30_000).unref();

/**
 * All read-only REST routes the web UI needs. Mounted on BOTH the main app (8787)
 * and the spectator app (80) so the static page can hit /api/* via same-origin
 * regardless of which port the user loaded it from.
 */
function mountApiRoutes(target: express.Express): void {
  target.get("/api/missions", (_req, res) => {
    res.json({ version: 1, missions: ALL_MISSIONS });
  });
  target.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  target.get("/api/rating/:uuid", (req, res) => {
    if (!UUID_RE.test(req.params.uuid)) return res.status(400).json({ error: "bad_uuid" });
    const row = getPlayer(req.params.uuid);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  });
  target.get("/api/leaderboard", (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    res.json({ players: getLeaderboard(limit) });
  });
  target.get("/api/matches", (req, res) => {
    const uuid = req.query.uuid ? String(req.query.uuid) : null;
    const player = req.query.player ? String(req.query.player) : null;
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);
    if (uuid) {
      if (!UUID_RE.test(uuid)) return res.status(400).json({ error: "bad_uuid" });
      return res.json({ matches: getRecentMatches(uuid, limit), total: undefined });
    }
    if (player) {
      return res.json({
        matches: getMatchesByPlayerName(player, limit, offset),
        total: getMatchCount(player),
      });
    }
    return res.json({ matches: getAllMatches(limit, offset), total: getMatchCount() });
  });
  target.get("/api/matches/:id", (req, res) => {
    const id = Number(req.params.id);
    // M1: tighten from `isFinite` (which lets floats / scientific notation through)
    // to a positive integer check matching the SQLite AUTOINCREMENT id space.
    if (!Number.isInteger(id) || id < 1 || id > Number.MAX_SAFE_INTEGER) {
      return res.status(400).json({ error: "bad_id" });
    }
    const row = getMatchById(id);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  });
  target.get("/api/players/search", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ players: [] });
    // Length cap so a 100KB `?q=` doesn't tie up the (synchronous) sqlite query.
    if (q.length > 64) return res.status(400).json({ error: "query_too_long" });
    const limit = clampInt(req.query.limit, 50, 1, 100);
    res.json({ players: searchPlayersByName(q, limit) });
  });
  target.get("/api/players/:uuid", (req, res) => {
    if (!UUID_RE.test(req.params.uuid)) return res.status(400).json({ error: "bad_uuid" });
    const row = getPlayer(req.params.uuid);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  });
  target.get("/api/rooms", (_req, res) => {
    res.json({ rooms: rooms.listActive() });
  });
}

function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// Main API + WS server (mod connects here; backwards-compat also serves the board UI)
const app = express();
app.use(express.static(PUBLIC_DIR));
mountApiRoutes(app);

// Spectator HTTP server on a friendlier port. Same static files + same read-only
// API surface so the SPA works identically regardless of which port served it.
const spectatorApp = express();
spectatorApp.use(express.static(PUBLIC_DIR));
mountApiRoutes(spectatorApp);

const httpServer = createServer(app);
const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  maxPayload: MAX_WS_PAYLOAD, // H6
  verifyClient: (info, cb) => {
    // H8: reject cross-site WS hijacking. The mod's Java HttpClient sends no
    // Origin header (allowed). Browsers send Origin = the page's origin;
    // we allow it iff its hostname matches the Host header's hostname — i.e.
    // the browser is loading from the same machine it's targeting. This auto-
    // adapts to whatever address the server is reachable on (localhost, LAN
    // IP, public IP, DNS name) without needing a hardcoded allowlist, and
    // still blocks the textbook CSWSH attack (page on evil.com → WS to us:
    // Origin host ≠ our Host).
    const origin = info.req.headers.origin;
    if (!origin) return cb(true);
    try {
      const originHost = new URL(origin).hostname.toLowerCase();
      const reqHost = (info.req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
      if (originHost && originHost === reqHost) return cb(true);
      console.warn(`[ws] rejected origin: ${origin} (req host=${info.req.headers.host})`);
      return cb(false, 403, "origin_mismatch");
    } catch {
      return cb(false, 400, "bad_origin");
    }
  },
});
const spectatorHttpServer = createServer(spectatorApp);

interface ConnState {
  playerId: string;
  room: Room | null;
  isSpectator: boolean;
  remoteAddr: string | null;
  /** H2: token bucket fields. */
  tokens: number;
  lastRefillAt: number;
  /** M3: spectate brute-force backoff. */
  spectateFailCount: number;
  spectateBlockedUntil: number;
}

const conns = new WeakMap<WebSocket, ConnState>();
/** H4: per-remote-address concurrent connection count. */
const connsByIp = new Map<string, number>();

function refillTokens(state: ConnState): void {
  const now = Date.now();
  const elapsed = (now - state.lastRefillAt) / 1000;
  if (elapsed <= 0) return;
  state.tokens = Math.min(RATE_BUCKET_CAP, state.tokens + elapsed * RATE_BUCKET_REFILL_PER_SEC);
  state.lastRefillAt = now;
}

/** True if the message should be allowed; false (and message dropped) otherwise. */
function consumeToken(state: ConnState, cost = 1): boolean {
  refillTokens(state);
  if (state.tokens < cost) return false;
  state.tokens -= cost;
  return true;
}

function getRemoteAddr(req: IncomingMessage): string | null {
  // Trust the socket directly — we don't currently sit behind a reverse proxy.
  // If we move behind nginx, replace this with a verified `X-Forwarded-For`
  // parser (and set an `trust proxy` whitelist).
  return req.socket.remoteAddress ?? null;
}

wss.on("connection", (ws, req) => {
  const remoteAddr = getRemoteAddr(req);

  // H4: enforce per-IP connection cap before any further state allocation.
  if (remoteAddr) {
    const current = connsByIp.get(remoteAddr) ?? 0;
    if (current >= MAX_CONNS_PER_IP) {
      console.warn(`[ws] rejecting ${remoteAddr}: ${current} active conns >= cap`);
      ws.close(1008, "too_many_connections");
      return;
    }
    connsByIp.set(remoteAddr, current + 1);
  }

  const state: ConnState = {
    playerId: nanoid(),
    room: null,
    isSpectator: false,
    remoteAddr,
    tokens: RATE_BUCKET_CAP,
    lastRefillAt: Date.now(),
    spectateFailCount: 0,
    spectateBlockedUntil: 0,
  };
  conns.set(ws, state);
  console.log(`[ws] connect ${state.playerId} from ${remoteAddr ?? "?"}`);

  ws.on("message", (raw) => {
    // H2: rate-limit BEFORE doing any parsing work.
    if (!consumeToken(state)) {
      sendError(ws, "rate_limited", "too many messages");
      // Don't disconnect on first violation — let the bucket refill. But if the
      // attacker keeps pushing, the bucket stays empty and each call just drops
      // through here. Cheap.
      return;
    }
    const text = raw.toString();
    const msg = decode(text);
    if (!msg) {
      // M4: log only that a message was rejected, not its contents.
      console.warn(`[ws] ${state.playerId} bad message (${text.length}B)`);
      sendError(ws, "bad_message", "could not parse message");
      return;
    }
    // M4: redact chat/world_event bodies in the log — they may contain PII.
    if (msg.type === "chat" || msg.type === "world_event") {
      console.log(`[ws] ${state.playerId} <- ${msg.type} (${text.length}B)`);
    } else {
      console.log(`[ws] ${state.playerId} <- ${text.slice(0, 200)}`);
    }
    handleClientMessage(ws, state, msg);
  });

  ws.on("close", () => {
    console.log(`[ws] close ${state.playerId}`);
    if (remoteAddr) {
      const current = connsByIp.get(remoteAddr) ?? 0;
      if (current <= 1) connsByIp.delete(remoteAddr);
      else connsByIp.set(remoteAddr, current - 1);
    }

    if (!state.room) return;
    if (state.isSpectator) {
      state.room.removeSpectator(ws);
      // H1: if the room has no players left and is already ended, free it.
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
  });
});

function handleClientMessage(
  ws: WebSocket,
  state: ConnState,
  msg: import("./protocol.js").ClientMessage,
): void {
  switch (msg.type) {
    case "ping":
      send(ws, { type: "pong" });
      return;

    case "create_room": {
      if (state.room) return sendError(ws, "already_in_room", "leave first");
      // C1 (partial): refuse if this UUID is already in another active room.
      if (msg.uuid && rooms.findRoomContainingUuid(msg.uuid)) {
        return sendError(ws, "uuid_in_use", "this account is already in a room");
      }
      const room = rooms.create();
      const session = room.addPlayer(
        state.playerId, msg.playerName, msg.uuid ?? null, ws, state.remoteAddr,
      );
      if (!session) {
        // Don't leak the freshly-created room if addPlayer failed for any reason.
        // The idle TTL reaper would eventually catch it, but no point waiting.
        rooms.delete(room.code);
        return sendError(ws, "join_failed", "could not join created room");
      }
      state.room = room;
      room.notifyJoin();
      return;
    }

    case "join_room": {
      if (state.room) return sendError(ws, "already_in_room", "leave first");
      const room = rooms.get(msg.roomCode);
      if (!room) return sendError(ws, "room_not_found", `no room ${msg.roomCode}`);

      // C3: attempt reconnect first. If this UUID has a disconnected slot in
      // this room, restore it instead of treating it as a fresh join.
      if (msg.uuid) {
        const disconnected = room.findDisconnectedByUuid(msg.uuid);
        if (disconnected) {
          const restored = room.reconnectPlayer(disconnected.id, ws, state.remoteAddr);
          if (restored) {
            // Adopt the original playerId so the rest of the room treats us as
            // the same logical participant.
            state.playerId = disconnected.id;
            state.room = room;
            room.sendReconnectSnapshot(disconnected.id);
            room.notifyJoin();
            console.log(`[ws] ${state.playerId} reconnected to ${room.code}`);
            return;
          }
        }

        // C1 (partial): block joining if this UUID is active in a DIFFERENT room.
        const elsewhere = rooms.findRoomContainingUuid(msg.uuid);
        if (elsewhere && elsewhere !== room) {
          return sendError(ws, "uuid_in_use", "this account is already in another room");
        }
      }

      const session = room.addPlayer(
        state.playerId, msg.playerName, msg.uuid ?? null, ws, state.remoteAddr,
      );
      if (!session) return sendError(ws, "room_full", "room already has 2 players");
      state.room = room;
      room.notifyJoin();
      return;
    }

    case "update_settings": {
      if (!state.room || state.isSpectator) return sendError(ws, "no_room", "not in a room");
      const ok = state.room.updateSettings(state.playerId, msg.settings);
      if (!ok) return sendError(ws, "not_host", "only host can update settings");
      state.room.notifyJoin();
      return;
    }

    case "start_match": {
      if (!state.room || state.isSpectator) return sendError(ws, "no_room", "not in a room");
      const result = state.room.startMatchByHost(state.playerId);
      if (!result.ok) return sendError(ws, result.reason ?? "cannot_start", "cannot start match");
      return;
    }

    case "world_ready": {
      if (!state.room || state.isSpectator) return;
      state.room.markReady(state.playerId);
      return;
    }

    case "spectate": {
      if (state.room) return sendError(ws, "already_in_room", "leave first");

      // M3: throttle spectate failures so the 32^4 room-code space can't be
      // brute-forced from a single connection.
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

      const accepted = room.addSpectator(ws);
      if (!accepted) {
        return sendError(ws, "spectator_full", "room spectator slots are full");
      }
      state.room = room;
      state.isSpectator = true;
      state.spectateFailCount = 0;
      return;
    }

    case "leave_room": {
      if (!state.room) return;
      if (state.isSpectator) {
        state.room.removeSpectator(ws);
      } else {
        // Explicit leave — bypass the C3 grace period and tear down immediately.
        state.room.forceRemovePlayer(state.playerId);
        if (state.room.size() === 0) {
          rooms.delete(state.room.code);
        } else {
          state.room.notifyJoin();
        }
      }
      state.room = null;
      state.isSpectator = false;
      return;
    }

    case "claim": {
      if (!state.room || state.isSpectator) {
        return sendError(ws, "no_match", "not in a match");
      }
      state.room.attemptClaim(state.playerId, msg.tileId, msg.missionId);
      return;
    }

    case "chat": {
      if (!state.room || state.isSpectator) return sendError(ws, "no_room", "not in a room");
      const text = msg.text.trim();
      if (!text) return;
      state.room.broadcastChat(state.playerId, text.slice(0, 256));
      return;
    }

    case "world_event": {
      if (!state.room || state.isSpectator) return sendError(ws, "no_room", "not in a room");
      const text = msg.text.trim();
      if (!text) return;
      state.room.broadcastWorldEvent(state.playerId, msg.kind, text.slice(0, 512));
      return;
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(encode(msg));
}

function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { type: "error", code, message });
}

httpServer.listen(PORT, () => {
  console.log(`mchx api/ws server listening on http://localhost:${PORT}`);
  console.log(`  ws endpoint: ws://localhost:${PORT}/ws`);
  console.log(`  loaded ${ALL_MISSIONS.length} missions`);
});

spectatorHttpServer.listen(SPECTATOR_PORT, () => {
  console.log(`mchx spectator board listening on http://localhost:${SPECTATOR_PORT}`);
});
