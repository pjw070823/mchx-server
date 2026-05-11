import { createServer } from "node:http";
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
const SPECTATOR_PORT = Number(process.env.SPECTATOR_PORT ?? 8000);
const PUBLIC_DIR = resolve(__dirname, "../public");

// Main API + WS server (mod connects here; backwards-compat also serves the board UI)
const app = express();
app.use(express.static(PUBLIC_DIR));
app.get("/api/missions", (_req, res) => {
  res.json({ version: 1, missions: ALL_MISSIONS });
});
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});
app.get("/api/rating/:uuid", (req, res) => {
  const row = getPlayer(req.params.uuid);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(row);
});
app.get("/api/leaderboard", (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json({ players: getLeaderboard(limit) });
});
app.get("/api/matches", (req, res) => {
  const uuid = req.query.uuid ? String(req.query.uuid) : null;
  const player = req.query.player ? String(req.query.player) : null;
  const limit = Number(req.query.limit ?? 20);
  const offset = Number(req.query.offset ?? 0);
  if (uuid) {
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
app.get("/api/matches/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  const row = getMatchById(id);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(row);
});
app.get("/api/players/search", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json({ players: [] });
  const limit = Number(req.query.limit ?? 50);
  res.json({ players: searchPlayersByName(q, limit) });
});
app.get("/api/players/:uuid", (req, res) => {
  const row = getPlayer(req.params.uuid);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(row);
});
app.get("/api/rooms", (_req, res) => {
  res.json({ rooms: rooms.listActive() });
});

// Spectator-only HTTP server. Serves the same static files + /api/missions but no WS.
// Lets us expose the board on a friendlier port without entangling the mod's WS port.
const spectatorApp = express();
spectatorApp.use(express.static(PUBLIC_DIR));
spectatorApp.get("/api/missions", (_req, res) => {
  res.json({ version: 1, missions: ALL_MISSIONS });
});
spectatorApp.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
const rooms = new RoomRegistry();
const spectatorHttpServer = createServer(spectatorApp);

interface ConnState {
  playerId: string;
  room: Room | null;
  isSpectator: boolean;
}

const conns = new WeakMap<WebSocket, ConnState>();

wss.on("connection", (ws, req) => {
  const state: ConnState = { playerId: nanoid(), room: null, isSpectator: false };
  conns.set(ws, state);
  console.log(`[ws] connect ${state.playerId} from ${req.socket.remoteAddress}`);

  ws.on("message", (raw) => {
    const text = raw.toString();
    console.log(`[ws] ${state.playerId} <- ${text.slice(0, 200)}`);
    const msg = decode(text);
    if (!msg) {
      console.warn(`[ws] ${state.playerId} bad message`);
      sendError(ws, "bad_message", "could not parse message");
      return;
    }
    handleClientMessage(ws, state, msg);
  });

  ws.on("close", () => {
    console.log(`[ws] close ${state.playerId}`);
    if (!state.room) return;
    if (state.isSpectator) {
      state.room.removeSpectator(ws);
    } else {
      const { wasPlaying } = state.room.removePlayer(state.playerId);
      if (state.room.size() === 0 && !wasPlaying) {
        rooms.delete(state.room.code);
      } else {
        state.room.notifyJoin();
      }
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
      const room = rooms.create();
      const session = room.addPlayer(state.playerId, msg.playerName, msg.uuid ?? null, ws);
      if (!session) return sendError(ws, "join_failed", "could not join created room");
      state.room = room;
      room.notifyJoin();
      return;
    }

    case "join_room": {
      if (state.room) return sendError(ws, "already_in_room", "leave first");
      const room = rooms.get(msg.roomCode);
      if (!room) return sendError(ws, "room_not_found", `no room ${msg.roomCode}`);
      const session = room.addPlayer(state.playerId, msg.playerName, msg.uuid ?? null, ws);
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
      const room = rooms.get(msg.roomCode);
      if (!room) return sendError(ws, "room_not_found", `no room ${msg.roomCode}`);
      state.room = room;
      state.isSpectator = true;
      room.addSpectator(ws);
      return;
    }

    case "leave_room": {
      if (!state.room) return;
      if (state.isSpectator) {
        state.room.removeSpectator(ws);
      } else {
        state.room.removePlayer(state.playerId);
        state.room.notifyJoin();
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
