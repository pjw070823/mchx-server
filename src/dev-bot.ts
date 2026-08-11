// Dev-only: simulates two players claiming tiles to exercise the server + spectator UI.
// Usage:
//   npx tsx src/dev-bot.ts                  (auto-creates room, both bots play)
//   npx tsx src/dev-bot.ts ranked           (both bots queue — exercises matchmaking)
//   npx tsx src/dev-bot.ts ABCD             (joins existing room, plays randomly)
//   npx tsx src/dev-bot.ts ABCD passive     (joins existing room, never claims — for human testing)
//
// `ranked` needs the server started with MCHX_DEV_QUEUE=1: bots have no Minecraft
// account and share an address, which are the two things the queue refuses outright.
// That is the point of the switch — it is also what keeps the resulting match unrated.
//
// Override the target with MCHX_WS=ws://host:port/ws.

import WebSocket from "ws";
import type { ServerMessage } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

const URL = process.env.MCHX_WS ?? "ws://localhost:8787/ws";
const ARG = process.argv[2];
const RANKED = ARG === "ranked";
const ROOM_ARG = RANKED ? undefined : ARG;
const PASSIVE = process.argv[3] === "passive";

/**
 * The server refuses any claim landing sooner than `minTimeToFirstClaimMs` after the
 * countdown ends (anti-cheat gate in room.ts, 15s by default) and throttles consecutive
 * claims to `minIntervalBetweenClaimsMs` (1s). Mirrored here rather than imported:
 * importing room.ts would drag db.ts in and open the real SQLite file in this process.
 * Keep in sync with DEFAULT_ROOM_CONFIG.
 */
const FIRST_CLAIM_GATE_MS = 15_000;
/**
 * How long the bots wait between claims. The server floor is 1s; raising it via
 * MCHX_BOT_CLAIM_MS stretches the match out, which is the only way to keep a board
 * on screen long enough to look at.
 */
const CLAIM_INTERVAL_MS = Math.max(1_000, Number(process.env.MCHX_BOT_CLAIM_MS) || 1_000);
/** Headroom over each server-side gate so clock jitter doesn't trip a rejection. */
const GATE_MARGIN_MS = 750;

interface BoardTile {
  tileId: string;
  missionId: string;
  difficulty: string;
  q: number;
  r: number;
}

interface BotState {
  ws: WebSocket;
  name: string;
  side: "A" | "B" | null;
  board: BoardTile[];
  claimed: Set<string>;
  roomCode: string | null;
  playing: boolean;
}

function connectBot(name: string, mode: "create" | "queue" | { join: string }): BotState {
  const ws = new WebSocket(URL);
  const state: BotState = {
    ws, name, side: null, board: [], claimed: new Set(), roomCode: null, playing: false,
  };

  ws.on("open", () => {
    // The version handshake is required before a room will seat you. Bots stay
    // unauthenticated on purpose — they have no Minecraft account, so their matches
    // are unrated, which is exactly what you want from a test harness.
    ws.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, clientVersion: "dev-bot" }));
    if (mode === "queue") {
      ws.send(JSON.stringify({ type: "join_queue" }));
    } else if (mode === "create") {
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
      // Ranked rooms are built and started by the matchmaker: there is no second bot to
      // spawn and no host to press start. Both branches below would be no-ops anyway
      // (hostId is null for ranked), but gating them keeps the intent legible.
      if (RANKED) return;

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
      state.board = msg.board as BoardTile[];
      state.claimed = new Set(msg.claimed.map((c) => c.tileId));
      state.playing = true;
      console.log(`[${state.name}] match start, side=${msg.yourSide}, seed=${msg.seed}`);
      console.log(`  spectate at: ${spectatorUrl(state.roomCode)}`);
      // The real mod reports readiness once its world has finished loading; without
      // this the server never arms `matchActiveAt` and every claim comes back as
      // "countdown". Bots have no world to load, so report immediately.
      state.ws.send(JSON.stringify({ type: "world_ready" }));
      return;
    case "countdown_start": {
      if (PASSIVE) {
        console.log(`[${state.name}] passive mode — will not claim. Run with mission tracker.`);
        return;
      }
      // Claims are only legal once the countdown has elapsed AND the anti-cheat
      // first-claim gate has passed.
      const startIn = Math.max(0, msg.startsAt - Date.now()) + FIRST_CLAIM_GATE_MS + GATE_MARGIN_MS;
      console.log(`[${state.name}] countdown armed — first claim in ${(startIn / 1000).toFixed(1)}s`);
      setTimeout(() => playLoop(state), startIn);
      return;
    }
    case "tile_claimed":
      state.claimed.add(msg.tileId);
      return;
    case "match_end":
      state.playing = false;
      console.log(`[${state.name}] match end — winner=${msg.winner} (${msg.reason})`);
      setTimeout(() => state.ws.close(), 500);
      return;
    case "claim_rejected":
      console.warn(`[${state.name}] claim rejected ${msg.tileId}: ${msg.reason}`);
      return;
    case "queue_state":
      console.log(
        `[${state.name}] queue: queued=${msg.queued}` +
          (msg.reason ? ` reason=${msg.reason}` : "") +
          ` waited=${(msg.waitingMs / 1000).toFixed(1)}s size=${msg.size} elo=${msg.elo} window=±${msg.window}`,
      );
      return;
  }
}

function spectatorUrl(code: string | null): string {
  const host = URL.replace(/^ws/, "http").replace(/\/ws$/, "");
  return code ? `${host}/#/board/${code}` : host;
}

/**
 * Pick the next tile to claim.
 *
 * Random walking takes dozens of claims to produce a winner, which makes the bot
 * useless as a smoke test. Instead each bot beelines along its own winning axis —
 * side A needs a chain spanning r=0..4 (a column of fixed q), side B needs q=0..4
 * (a row of fixed r). We choose the line with the fewest tiles already taken by
 * anyone and claim its remaining tiles, so a match resolves in ~5 claims. Falls
 * back to any unclaimed tile if every line is contested.
 */
function nextTile(state: BotState): BoardTile | null {
  const free = state.board.filter((t) => !state.claimed.has(t.tileId));
  if (free.length === 0) return null;

  const alongAxis = state.side === "A"
    ? (t: BoardTile, line: number) => t.q === line
    : (t: BoardTile, line: number) => t.r === line;

  // Scan A's candidate lines low-to-high and B's high-to-low. Ties keep the first
  // line seen, so the two bots start from opposite corners of the rhombus and stop
  // fighting over the same tiles every single turn.
  const lines = state.side === "A" ? [0, 1, 2, 3, 4] : [4, 3, 2, 1, 0];
  let best: { line: number; tiles: BoardTile[] } | null = null;
  for (const line of lines) {
    const tiles = free.filter((t) => alongAxis(t, line));
    if (best === null || tiles.length > best.tiles.length) best = { line, tiles };
  }
  if (best && best.tiles.length > 0) {
    // Walk the line in order so the chain grows contiguously.
    const sorted = [...best.tiles].sort((x, y) => (state.side === "A" ? x.r - y.r : x.q - y.q));
    return sorted[0]!;
  }
  return free[Math.floor(Math.random() * free.length)]!;
}

function playLoop(state: BotState) {
  if (!state.playing) return;
  if (state.ws.readyState !== state.ws.OPEN) return;

  const pick = nextTile(state);
  if (!pick) return;

  state.ws.send(JSON.stringify({
    type: "claim",
    tileId: pick.tileId,
    missionId: pick.missionId,
  }));

  setTimeout(() => playLoop(state), CLAIM_INTERVAL_MS + GATE_MARGIN_MS);
}

if (RANKED) {
  // Both go in at once. The matchmaker pairs them on its next tick and starts the
  // match itself, so there is nothing else to drive from here.
  connectBot("Alice", "queue");
  connectBot("Bob", "queue");
} else if (ROOM_ARG) {
  connectBot("Bob", { join: ROOM_ARG });
} else {
  connectBot("Alice", "create");
}
