// Dev-only: simulates two players claiming tiles to exercise the server + spectator UI.
// Usage:
//   npx tsx src/dev-bot.ts                  (auto-creates room, both bots play)
//   npx tsx src/dev-bot.ts ABCD             (joins existing room, plays randomly)
//   npx tsx src/dev-bot.ts ABCD passive     (joins existing room, never claims — for human testing)

import WebSocket from "ws";
import type { ServerMessage } from "./protocol.js";

const URL = process.env.MCHX_WS ?? "ws://localhost:8787/ws";
const ROOM_ARG = process.argv[2];
const PASSIVE = process.argv[3] === "passive";

interface BotState {
  ws: WebSocket;
  name: string;
  side: "A" | "B" | null;
  board: { tileId: string; missionId: string; difficulty: string }[];
  claimed: Set<string>;
  roomCode: string | null;
}

function connectBot(name: string, mode: "create" | { join: string }): BotState {
  const ws = new WebSocket(URL);
  const state: BotState = {
    ws, name, side: null, board: [], claimed: new Set(), roomCode: null,
  };

  ws.on("open", () => {
    if (mode === "create") {
      ws.send(JSON.stringify({ type: "create_room", playerName: name }));
    } else {
      ws.send(JSON.stringify({ type: "join_room", roomCode: mode.join, playerName: name }));
    }
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    onMessage(state, msg);
  });

  ws.on("close", () => {
    console.log(`[${name}] closed`);
  });

  ws.on("error", (e) => {
    console.error(`[${name}] error`, e.message);
  });

  return state;
}

function onMessage(state: BotState, msg: ServerMessage) {
  switch (msg.type) {
    case "error":
      console.error(`[${state.name}] server error: ${msg.code} — ${msg.message}`);
      return;
    case "room_state":
      state.roomCode = msg.roomCode;
      state.side = msg.you?.side ?? null;
      console.log(
        `[${state.name}] room=${msg.roomCode} status=${msg.status} you=${msg.you?.side ?? "?"} opp=${msg.opponent?.name ?? "—"}`,
      );
      if (
        msg.status === "waiting"
        && state.roomCode
        && !ROOM_ARG
        && state.name === "Alice"
        && !msg.opponent
      ) {
        // Spawn second bot to join — only when none yet
        setTimeout(() => connectBot("Bob", { join: msg.roomCode }), 500);
      }
      // If we are the host and both players are present, start the match.
      if (
        msg.status === "waiting"
        && msg.you
        && msg.opponent
        && msg.hostId === msg.you.id
      ) {
        setTimeout(() => state.ws.send(JSON.stringify({ type: "start_match" })), 500);
      }
      return;
    case "match_start":
      state.board = msg.board;
      console.log(`[${state.name}] match start, side=${msg.yourSide}, seed=${msg.seed}`);
      console.log(`  spectate at: http://localhost:8787/#room=${state.roomCode}`);
      if (PASSIVE) {
        console.log(`[${state.name}] passive mode — will not claim. Run with mission tracker.`);
        return;
      }
      setTimeout(() => playLoop(state), 1500);
      return;
    case "tile_claimed":
      state.claimed.add(msg.tileId);
      return;
    case "match_end":
      console.log(`[${state.name}] match end — winner=${msg.winner} (${msg.reason})`);
      setTimeout(() => state.ws.close(), 500);
      return;
    case "claim_rejected":
      console.warn(`[${state.name}] claim rejected ${msg.tileId}: ${msg.reason}`);
      return;
  }
}

function playLoop(state: BotState) {
  if (state.ws.readyState !== state.ws.OPEN) return;

  // Random unclaimed tile, weighted toward making a winning chain (loose strategy: prefer same edge tiles)
  const candidates = state.board.filter((t) => !state.claimed.has(t.tileId));
  if (candidates.length === 0) return;

  const wantsRow = state.side === "A";
  // Prefer tiles forming an edge or near a player's claimed tiles.
  const pick = candidates[Math.floor(Math.random() * candidates.length)]!;

  state.ws.send(JSON.stringify({
    type: "claim",
    tileId: pick.tileId,
    missionId: pick.missionId,
  }));

  // Slower cadence so spectators can watch tiles get claimed live.
  const next = 1500 + Math.random() * 1500;
  setTimeout(() => playLoop(state), next);
}

if (ROOM_ARG) {
  connectBot("Bob", { join: ROOM_ARG });
} else {
  connectBot("Alice", "create");
}
