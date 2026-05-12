import { customAlphabet } from "nanoid";
import type { WebSocket } from "ws";
import type {
  BoardTile,
  ClaimedTile,
  EloChange,
  PlayerInfo,
  RoomSettings,
  RoomStatus,
  ServerMessage,
  Side,
  TileId,
} from "./protocol.js";
import { DEFAULT_SETTINGS, encode } from "./protocol.js";
import { buildBoard, hasWon, mulberry32 } from "./hex.js";
import { getMission } from "./missions.js";
import {
  DEFAULT_ELO,
  applyMatchResult,
  getOrCreatePlayer,
  recordMatch,
  type PlayerRow,
} from "./db.js";
import { computeNewElo } from "./elo.js";

const newRoomCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

interface PlayerSession {
  id: string;
  name: string;
  side: Side | null;
  uuid: string | null;
  ws: WebSocket;
  /** Loaded from DB at addPlayer time, mutated after match end. */
  elo: number;
  gamesPlayed: number;
}

export class Room {
  readonly code: string;
  readonly seed: bigint;
  status: RoomStatus = "waiting";
  hostId: string | null = null;
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  private readonly players = new Map<string, PlayerSession>();
  private readonly spectators = new Set<WebSocket>();
  private board: BoardTile[] | null = null;
  private readonly claimedMap = new Map<TileId, Side>();
  private readonly claimedLog: ClaimedTile[] = [];
  private startedAt: number | null = null;
  private readonly readyPlayers = new Set<string>();
  private matchActiveAt: number | null = null;
  /** Lifecycle flag — true once we've ended this match and committed to DB. */
  private matchSettled = false;

  constructor() {
    this.code = newRoomCode();
    this.seed = randomSeed64();
  }

  size(): number {
    return this.players.size;
  }

  requiredPlayers(): number {
    return this.settings.gameMode === "2v2" ? 4 : 2;
  }

  /** Snapshot used by the public /api/rooms listing. No ws references, safe to serialise. */
  summary(): RoomSummary {
    return {
      code: this.code,
      status: this.status,
      capacity: this.requiredPlayers(),
      settings: this.settings,
      hostId: this.hostId,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        side: p.side,
        uuid: p.uuid,
        elo: p.elo,
        isHost: p.id === this.hostId,
      })),
    };
  }

  isReadyToStart(): boolean {
    return this.status === "waiting" && this.players.size === this.requiredPlayers();
  }

  addPlayer(playerId: string, name: string, uuid: string | null, ws: WebSocket): PlayerSession | null {
    if (this.players.size >= this.requiredPlayers()) return null;
    if (this.status !== "waiting") return null;
    const side: Side = this.players.size === 0 ? "A" : "B";
    let elo = DEFAULT_ELO;
    let gamesPlayed = 0;
    if (uuid) {
      try {
        const record = getOrCreatePlayer(uuid, name);
        elo = record.elo;
        gamesPlayed = record.games_played;
      } catch (e) {
        console.warn(`[room] getOrCreatePlayer failed: ${(e as Error).message}`);
      }
    }
    const session: PlayerSession = { id: playerId, name, side, uuid, ws, elo, gamesPlayed };
    this.players.set(playerId, session);
    if (this.hostId === null) this.hostId = playerId;
    return session;
  }

  removePlayer(playerId: string): { wasPlaying: boolean; remaining: PlayerSession | null } {
    const removed = this.players.get(playerId);
    if (!removed) return { wasPlaying: false, remaining: null };
    this.players.delete(playerId);
    const remaining = this.players.values().next().value ?? null;
    if (this.hostId === playerId) this.hostId = remaining?.id ?? null;
    if (this.status === "playing") {
      const winnerSide = remaining?.side ?? null;
      const eloChanges = this.settleMatch(winnerSide, "disconnect", removed);
      this.status = "ended";
      this.broadcast({
        type: "match_end",
        winner: winnerSide,
        reason: "disconnect",
        eloChanges,
      });
      return { wasPlaying: true, remaining };
    }
    return { wasPlaying: false, remaining };
  }

  addSpectator(ws: WebSocket): void {
    this.spectators.add(ws);
    this.sendRoomState(ws, null);
    if (this.status === "playing" || this.status === "ended") {
      this.sendMatchSnapshot(ws, null);
    }
  }

  removeSpectator(ws: WebSocket): void {
    this.spectators.delete(ws);
  }

  updateSettings(playerId: string, partial: Partial<RoomSettings>): boolean {
    if (this.hostId !== playerId) return false;
    if (this.status !== "waiting") return false;
    const next: RoomSettings = { ...this.settings };
    if (partial.gameMode != null) next.gameMode = partial.gameMode;
    if (partial.inventorySave != null) next.inventorySave = partial.inventorySave;
    if (partial.saturation != null) next.saturation = partial.saturation;
    if (partial.rated != null) next.rated = partial.rated;
    // No coupling between `rated` and the perk toggles — the host can freely combine
    // any of them. Ranked matches with non-default perks are still rated; record-keeping
    // captures the actual settings used so the leaderboard remains comparable per-room.
    this.settings = next;
    return true;
  }

  startMatchByHost(playerId: string): { ok: boolean; reason?: string } {
    if (this.hostId !== playerId) return { ok: false, reason: "not_host" };
    if (!this.isReadyToStart()) return { ok: false, reason: "not_ready" };
    this.beginMatch();
    return { ok: true };
  }

  private beginMatch(): void {
    const rand = mulberry32(Number(this.seed & 0xffffffffn));
    this.board = buildBoard(rand);
    this.startedAt = Date.now();
    this.status = "playing";
    this.readyPlayers.clear();
    this.matchActiveAt = null;
    this.matchSettled = false;
    for (const p of this.players.values()) this.sendMatchSnapshot(p.ws, p);
    for (const sp of this.spectators) this.sendMatchSnapshot(sp, null);
  }

  markReady(playerId: string): void {
    if (this.status !== "playing" || !this.board) return;
    if (!this.players.has(playerId)) return;
    if (this.matchActiveAt !== null) return;
    this.readyPlayers.add(playerId);
    if (this.readyPlayers.size >= this.players.size) {
      const startsAt = Date.now() + 3000;
      this.matchActiveAt = startsAt;
      this.broadcast({ type: "countdown_start", startsAt });
    }
  }

  broadcastChat(playerId: string, text: string): void {
    const sender = this.players.get(playerId);
    if (!sender) return;
    const msg: ServerMessage = {
      type: "chat_message",
      senderId: playerId,
      senderName: sender.name,
      text,
    };
    for (const [id, p] of this.players) {
      if (id !== playerId) this.send(p.ws, msg);
    }
    for (const sp of this.spectators) this.send(sp, msg);
  }

  broadcastWorldEvent(playerId: string, kind: "death" | "advancement", text: string): void {
    const sender = this.players.get(playerId);
    if (!sender) return;
    const msg: ServerMessage = {
      type: "world_event_message",
      senderId: playerId,
      senderName: sender.name,
      kind,
      text,
    };
    for (const [id, p] of this.players) {
      if (id !== playerId) this.send(p.ws, msg);
    }
    for (const sp of this.spectators) this.send(sp, msg);
  }

  attemptClaim(playerId: string, tileId: TileId, missionId: string): void {
    const player = this.players.get(playerId);
    if (!player || !player.side) return;
    if (this.status !== "playing" || !this.board) {
      this.send(player.ws, { type: "claim_rejected", tileId, reason: "match_not_active" });
      return;
    }
    if (this.matchActiveAt === null || Date.now() < this.matchActiveAt) {
      this.send(player.ws, { type: "claim_rejected", tileId, reason: "countdown" });
      return;
    }
    const tile = this.board.find((t) => t.tileId === tileId);
    if (!tile) {
      this.send(player.ws, { type: "claim_rejected", tileId, reason: "unknown_tile" });
      return;
    }
    if (tile.missionId !== missionId) {
      this.send(player.ws, { type: "claim_rejected", tileId, reason: "wrong_mission" });
      return;
    }
    if (!getMission(missionId)) {
      this.send(player.ws, { type: "claim_rejected", tileId, reason: "unknown_mission" });
      return;
    }
    if (this.claimedMap.has(tileId)) {
      this.send(player.ws, { type: "claim_rejected", tileId, reason: "already_claimed" });
      return;
    }

    const claimedAt = Date.now();
    this.claimedMap.set(tileId, player.side);
    this.claimedLog.push({ tileId, side: player.side, missionId, claimedAt });
    this.broadcast({ type: "tile_claimed", tileId, side: player.side, missionId, claimedAt });

    if (hasWon(player.side, this.claimedMap)) {
      const eloChanges = this.settleMatch(player.side, "connection", null);
      this.status = "ended";
      this.broadcast({
        type: "match_end",
        winner: player.side,
        reason: "connection",
        eloChanges,
      });
    }
  }

  /**
   * Compute ELO changes (if rated), update DB, persist the match row.
   * `quitter` is the player who disconnected if reason==="disconnect"; otherwise null.
   * Returns the per-player elo-change map for clients to display.
   */
  private settleMatch(
    winnerSide: Side | null,
    reason: "connection" | "forfeit" | "disconnect",
    quitter: PlayerSession | null,
  ): Record<string, EloChange> {
    if (this.matchSettled) return {};
    this.matchSettled = true;

    // Find side A and side B sessions even after `quitter` was removed from `players`.
    const all: PlayerSession[] = [...this.players.values()];
    if (quitter) all.push(quitter);
    const a = all.find((s) => s.side === "A") ?? null;
    const b = all.find((s) => s.side === "B") ?? null;

    const aScore: 0 | 0.5 | 1 = winnerSide === "A" ? 1 : winnerSide === "B" ? 0 : 0.5;
    const bScore: 0 | 0.5 | 1 = winnerSide === "B" ? 1 : winnerSide === "A" ? 0 : 0.5;

    const eloChanges: Record<string, EloChange> = {};
    let aBefore: number | null = null, aAfter: number | null = null;
    let bBefore: number | null = null, bAfter: number | null = null;

    if (this.settings.rated && a && b) {
      const updA = computeNewElo(a.elo, b.elo, a.gamesPlayed, aScore);
      const updB = computeNewElo(b.elo, a.elo, b.gamesPlayed, bScore);
      aBefore = updA.before; aAfter = updA.after;
      bBefore = updB.before; bAfter = updB.after;
      eloChanges[a.id] = updA;
      eloChanges[b.id] = updB;
      try {
        if (a.uuid) applyMatchResult(a.uuid, updA.after, aScore === 1 ? 1 : aScore === 0 ? -1 : 0);
        if (b.uuid) applyMatchResult(b.uuid, updB.after, bScore === 1 ? 1 : bScore === 0 ? -1 : 0);
      } catch (e) {
        console.warn(`[room] applyMatchResult failed: ${(e as Error).message}`);
      }
      // Reflect the new rating into the session so subsequent room_state broadcasts carry it.
      a.elo = updA.after;
      b.elo = updB.after;
    } else if (a && b) {
      aBefore = a.elo; aAfter = a.elo;
      bBefore = b.elo; bAfter = b.elo;
    }

    try {
      recordMatch({
        roomCode: this.code,
        seed: this.seed.toString(),
        startedAt: this.startedAt,
        endedAt: Date.now(),
        winnerSide: winnerSide ?? null,
        reason,
        settingsJson: JSON.stringify(this.settings),
        boardJson: JSON.stringify(this.board ?? []),
        claimedJson: JSON.stringify(this.claimedLog),
        playerAUuid: a?.uuid ?? null,
        playerAName: a?.name ?? null,
        playerAEloBefore: aBefore,
        playerAEloAfter: aAfter,
        playerBUuid: b?.uuid ?? null,
        playerBName: b?.name ?? null,
        playerBEloBefore: bBefore,
        playerBEloAfter: bAfter,
        rated: this.settings.rated,
      });
    } catch (e) {
      console.warn(`[room] recordMatch failed: ${(e as Error).message}`);
    }

    return eloChanges;
  }

  private sendRoomState(ws: WebSocket, viewer: PlayerSession | null): void {
    const sessions = Array.from(this.players.values());
    let you: PlayerSession | null;
    let opp: PlayerSession | null;
    if (viewer) {
      you = viewer;
      opp = sessions.find((s) => s.id !== viewer.id) ?? null;
    } else {
      you = sessions[0] ?? null;
      opp = sessions[1] ?? null;
    }
    this.send(ws, {
      type: "room_state",
      roomCode: this.code,
      status: this.status,
      you: you ? toPlayerInfo(you) : null,
      opponent: opp ? toPlayerInfo(opp) : null,
      hostId: this.hostId,
      settings: this.settings,
    });
  }

  private sendMatchSnapshot(ws: WebSocket, viewer: PlayerSession | null): void {
    if (!this.board || this.startedAt === null) return;
    this.send(ws, {
      type: "match_start",
      seed: this.seed,
      yourSide: viewer?.side ?? null,
      board: this.board,
      claimed: [...this.claimedLog],
      settings: this.settings,
      startsAt: this.startedAt,
    });
  }

  notifyJoin(): void {
    for (const p of this.players.values()) this.sendRoomState(p.ws, p);
    for (const sp of this.spectators) this.sendRoomState(sp, null);
  }

  private broadcast(msg: ServerMessage): void {
    for (const p of this.players.values()) this.send(p.ws, msg);
    for (const sp of this.spectators) this.send(sp, msg);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    const payload = encode(msg);
    console.log(`[ws] [${this.code}] -> ${payload.slice(0, 200)}`);
    ws.send(payload);
  }
}

function toPlayerInfo(s: PlayerSession): PlayerInfo {
  return { id: s.id, name: s.name, side: s.side, uuid: s.uuid, elo: s.elo };
}

function randomSeed64(): bigint {
  const hi = BigInt(Math.floor(Math.random() * 0x100000000));
  const lo = BigInt(Math.floor(Math.random() * 0x100000000));
  return BigInt.asIntN(64, (hi << 32n) | lo);
}

export interface RoomSummary {
  code: string;
  status: RoomStatus;
  capacity: number;
  settings: RoomSettings;
  hostId: string | null;
  players: Array<{
    id: string;
    name: string;
    side: Side | null;
    uuid: string | null;
    elo: number;
    isHost: boolean;
  }>;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  create(): Room {
    let code: string;
    let room: Room;
    do {
      room = new Room();
      code = room.code;
    } while (this.rooms.has(code));
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  /** Active rooms (status != ended) for the public listing on the web home page. */
  listActive(): RoomSummary[] {
    return [...this.rooms.values()]
      .filter((r) => r.status !== "ended")
      .map((r) => r.summary());
  }
}
