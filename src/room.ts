import { customAlphabet } from "nanoid";
import type { WebSocket } from "ws";
import type {
  BoardTile,
  ClaimedTile,
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

const newRoomCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

interface PlayerSession {
  id: string;
  name: string;
  side: Side | null;
  uuid: string | null;
  ws: WebSocket;
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

  isReadyToStart(): boolean {
    return this.status === "waiting" && this.players.size === this.requiredPlayers();
  }

  addPlayer(playerId: string, name: string, uuid: string | null, ws: WebSocket): PlayerSession | null {
    if (this.players.size >= this.requiredPlayers()) return null;
    if (this.status !== "waiting") return null;
    const side: Side = this.players.size === 0 ? "A" : "B";
    const session: PlayerSession = { id: playerId, name, side, uuid, ws };
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
      this.status = "ended";
      const winner = remaining?.side ?? null;
      this.broadcast({ type: "match_end", winner, reason: "disconnect" });
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
    this.settings = { ...this.settings, ...partial };
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
    this.startedAt = Date.now() + 3000;
    this.status = "playing";
    this.readyPlayers.clear();
    this.matchActiveAt = null;
    for (const p of this.players.values()) this.sendMatchSnapshot(p.ws, p);
    for (const sp of this.spectators) this.sendMatchSnapshot(sp, null);
  }

  /**
   * Called when a client finishes loading its singleplayer world. Once every player has
   * reported ready, we schedule the countdown (3s) and broadcast the active-at time.
   */
  markReady(playerId: string): void {
    if (this.status !== "playing" || !this.board) return;
    if (!this.players.has(playerId)) return;
    if (this.matchActiveAt !== null) return; // countdown already scheduled
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
    // send to everyone except sender (they see local echo); spectators get a copy too.
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
    // others only — sender sees their own death/advancement via vanilla chat already
    for (const [id, p] of this.players) {
      if (id !== playerId) this.send(p.ws, msg);
    }
    for (const sp of this.spectators) this.send(sp, msg);
  }

  attemptClaim(playerId: string, tileId: TileId, missionId: string): void {
    const player = this.players.get(playerId);
    if (!player || !player.side) return;
    if (this.status !== "playing" || !this.board) {
      this.send(player.ws, {
        type: "claim_rejected", tileId, reason: "match_not_active",
      });
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
      this.status = "ended";
      this.broadcast({ type: "match_end", winner: player.side, reason: "connection" });
    }
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
  return { id: s.id, name: s.name, side: s.side, uuid: s.uuid };
}

function randomSeed64(): bigint {
  const hi = BigInt(Math.floor(Math.random() * 0x100000000));
  const lo = BigInt(Math.floor(Math.random() * 0x100000000));
  return BigInt.asIntN(64, (hi << 32n) | lo);
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
}
