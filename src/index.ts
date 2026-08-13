import { createServer, type IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { nanoid } from "nanoid";
import { decode } from "./protocol.js";
import { RoomRegistry } from "./room.js";
import { ALL_MISSIONS } from "./missions.js";
import { mountApiRoutes } from "./api-routes.js";
import {
  handleClientMessage, handleClose, sendError, type ConnState, type ServerDeps,
} from "./handlers.js";
import { Matchmaker } from "./matchmaker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const SPECTATOR_PORT = Number(process.env.SPECTATOR_PORT ?? 80);
const PUBLIC_DIR = resolve(__dirname, "../public");

// --- Abuse limits ------------------------------------------------------------
//
// Everything below is about surviving a hostile client. The game rules live in
// room.ts and match-engine.ts; this file only decides who gets to speak.

/**
 * Cap on a single WebSocket frame. The largest legitimate client message is a chat
 * (256B) or world_event (512B); 8 KiB is generous headroom for JSON overhead, and
 * anything larger is an attack rather than a player.
 */
const MAX_WS_PAYLOAD = 8 * 1024;

/** Concurrent sockets from one address. Two players plus spectators behind one NAT fits. */
const MAX_CONNS_PER_IP = 10;

/** Token bucket: short bursts are fine, sustained flooding is not. */
const RATE_BUCKET_CAP = 60;
const RATE_BUCKET_REFILL_PER_SEC = 20;

/**
 * How long an empty room survives before the reaper takes it. The disconnect path
 * already deletes empty rooms immediately; this is the safety net for the cases it
 * misses. Short enough that idle rooms don't clutter `/api/rooms`, long enough that a
 * quick disconnect-reconnect doesn't lose the room.
 */
const EMPTY_ROOM_TTL_MS = 60_000;

/**
 * How often half-dead sockets are swept.
 *
 * Required by the queue rather than nice to have: a pairing goes straight into a rated
 * match with no accept step, so a socket that stopped answering must not keep its slot
 * and get handed a real opponent. Two missed pongs closes it, which routes into the
 * normal removePlayer → grace → forfeit path.
 */
const PING_INTERVAL_MS = 30_000;

const rooms = new RoomRegistry();
const matchmaker = new Matchmaker({ rooms });
matchmaker.start();
const deps: ServerDeps = { rooms, matchmaker };

setInterval(() => {
  const reaped = rooms.reapIdle(EMPTY_ROOM_TTL_MS);
  if (reaped > 0) console.log(`[rooms] reaped ${reaped} idle room(s)`);
}, 30_000).unref();

// --- HTTP ---------------------------------------------------------------------

// Mod-facing API + WebSocket. Also serves the board UI for backwards compatibility.
const app = express();
app.use(express.static(PUBLIC_DIR));
mountApiRoutes(app, rooms);

// Spectator board on a friendlier port, with the same static files and the same
// read-only API surface so the SPA behaves identically whichever port served it.
const spectatorApp = express();
spectatorApp.use(express.static(PUBLIC_DIR));
mountApiRoutes(spectatorApp, rooms);

const httpServer = createServer(app);
const spectatorHttpServer = createServer(spectatorApp);

const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  maxPayload: MAX_WS_PAYLOAD,
  verifyClient: (info, cb) => {
    // Reject cross-site WebSocket hijacking. The mod's Java HttpClient sends no Origin
    // (allowed); browsers always do, and we accept it only when its host matches the
    // Host header — i.e. the page came from the machine it is talking to. That adapts
    // to localhost, LAN IP, public IP or DNS name without an allowlist, while still
    // blocking the textbook attack (page on evil.com opening a socket to us).
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

// --- connection lifecycle --------------------------------------------------------

const conns = new WeakMap<WebSocket, ConnState>();
/** Concurrent connection count per remote address. */
const connsByIp = new Map<string, number>();

function refillTokens(state: ConnState): void {
  const now = Date.now();
  const elapsed = (now - state.lastRefillAt) / 1000;
  if (elapsed <= 0) return;
  state.tokens = Math.min(RATE_BUCKET_CAP, state.tokens + elapsed * RATE_BUCKET_REFILL_PER_SEC);
  state.lastRefillAt = now;
}

/** True if the message may proceed; false means it was dropped. */
function consumeToken(state: ConnState, cost = 1): boolean {
  refillTokens(state);
  if (state.tokens < cost) return false;
  state.tokens -= cost;
  return true;
}

function getRemoteAddr(req: IncomingMessage): string | null {
  // Read the socket directly — there is no reverse proxy in front of us today. Behind
  // nginx this must become a verified X-Forwarded-For parse with a trusted-proxy list,
  // otherwise the per-IP limits and the same-IP self-play guard both become spoofable.
  return req.socket.remoteAddress ?? null;
}

wss.on("connection", (ws, req) => {
  const remoteAddr = getRemoteAddr(req);

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
    protocolVersion: null,
    clientVersion: null,
    challenge: null,
    verified: null,
    queueCooldownUntil: 0,
    isAlive: true,
  };
  conns.set(ws, state);
  console.log(`[ws] connect ${state.playerId} from ${remoteAddr ?? "?"}`);

  ws.on("pong", () => { state.isAlive = true; });

  ws.on("message", (raw) => {
    // Rate-limit before doing any parsing work.
    if (!consumeToken(state)) {
      // Don't disconnect on a single violation — let the bucket refill. A client that
      // keeps pushing simply keeps landing here, which costs us almost nothing.
      return sendError(ws, "rate_limited", "too many messages");
    }

    const text = raw.toString();
    const msg = decode(text);
    if (!msg) {
      // Log that something was rejected, never its contents.
      console.warn(`[ws] ${state.playerId} bad message (${text.length}B)`);
      return sendError(ws, "bad_message", "could not parse message");
    }

    // Chat and world events can carry player-authored text; log only their size.
    if (msg.type === "chat" || msg.type === "world_event") {
      console.log(`[ws] ${state.playerId} <- ${msg.type} (${text.length}B)`);
    } else {
      console.log(`[ws] ${state.playerId} <- ${text.slice(0, 200)}`);
    }

    handleClientMessage(ws, state, msg, deps);
  });

  ws.on("close", () => {
    console.log(`[ws] close ${state.playerId}`);
    if (remoteAddr) {
      const current = connsByIp.get(remoteAddr) ?? 0;
      if (current <= 1) connsByIp.delete(remoteAddr);
      else connsByIp.set(remoteAddr, current - 1);
    }
    handleClose(ws, state, deps);
  });
});

/**
 * Close sockets that stopped answering.
 *
 * A TCP connection can look open long after the peer is gone — no FIN arrives from a
 * killed process on a dropped network. Without this, such a socket keeps its queue slot
 * and can be paired into a rated match nobody will ever play.
 */
setInterval(() => {
  for (const ws of wss.clients) {
    const state = conns.get(ws);
    if (!state) continue;
    if (!state.isAlive) {
      console.warn(`[ws] ${state.playerId} missed two pings — terminating`);
      ws.terminate();
      continue;
    }
    state.isAlive = false;
    ws.ping();
  }
}, PING_INTERVAL_MS).unref();

httpServer.listen(PORT, () => {
  console.log(`mchx api/ws server listening on http://localhost:${PORT}`);
  console.log(`  ws endpoint: ws://localhost:${PORT}/ws`);
  console.log(`  loaded ${ALL_MISSIONS.length} missions`);
});

spectatorHttpServer.listen(SPECTATOR_PORT, () => {
  console.log(`mchx spectator board listening on http://localhost:${SPECTATOR_PORT}`);
});
