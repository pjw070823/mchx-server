import { customAlphabet } from "nanoid";
import { randomBytes } from "node:crypto";
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
  inTransaction,
  recordMatch,
  type PlayerRow,
} from "./db.js";
import { computeNewElo } from "./elo.js";

const newRoomCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

/** H3: hard cap on spectators per room so a single attacker can't fan-out broadcasts. */
const MAX_SPECTATORS_PER_ROOM = 50;

/** C3: grace period after a player's WS closes before the match is forfeited. */
const RECONNECT_GRACE_MS = 30_000;

/**
 * C2: anti-cheat time gates on `claim`. Real play can't realistically complete a
 * mission inside MIN_TIME_TO_FIRST_CLAIM or rapid-fire claims faster than
 * MIN_INTERVAL_BETWEEN_CLAIMS. These values are conservative — legitimate fast
 * starts shouldn't trip them, but a script firing all 25 claims at t=0 will.
 */
const MIN_TIME_TO_FIRST_CLAIM_MS = 15_000;
const MIN_INTERVAL_BETWEEN_CLAIMS_MS = 1_000;

interface PlayerSession {
  id: string;
  name: string;
  side: Side | null;
  uuid: string | null;
  ws: WebSocket;
  /** Loaded from DB at addPlayer time, mutated after match end. */
  elo: number;
  gamesPlayed: number;
  /** C3: set when the WS closes; cleared on reconnect. Non-null = pending forfeit. */
  disconnectedAt: number | null;
  /** C3: pending forfeit timer; cancelled on reconnect. */
  forfeitTimer: ReturnType<typeof setTimeout> | null;
  /** C1: remote IP at connect time, used for self-play detection. */
  remoteAddr: string | null;
  /** C2: last successful claim timestamp, for anti-rapid-fire gate. */
  lastClaimAt: number | null;
}

export class Room {
  readonly code: string;
  /** Re-rolled on every beginMatch() so rematches use fresh maps. */
  seed: bigint;
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
  /**
   * Wall-clock time at which this room became empty (size==0), or null if it
   * currently has at least one player session. Used by [RoomRegistry.reapIdle]
   * to delete rooms that stay empty for too long — catches the edge cases the
   * inline disconnect cleanup misses (e.g. addPlayer-fails-after-create, both
   * forfeit timers firing, spectator-only rooms after the match ended).
   *
   * Initialised to `Date.now()` because a newly-constructed Room has size 0;
   * the `addPlayer` success path clears it.
   */
  private emptiedAt: number | null = Date.now();

  constructor() {
    this.code = newRoomCode();
    this.seed = randomSeed64();
  }

  /** Idle-TTL probe. Returns the timestamp the room went empty, or null if occupied. */
  idleSince(): number | null {
    return this.emptiedAt;
  }

  /** Refresh `emptiedAt` based on current player count. Called after every mutation. */
  private touchEmpty(): void {
    if (this.players.size === 0) {
      if (this.emptiedAt === null) this.emptiedAt = Date.now();
    } else {
      this.emptiedAt = null;
    }
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
    // Allow start from both `waiting` (first match in this room) and `ended`
    // (rematch in the same room). `playing`/`starting` is a no-op so the host
    // can't double-start mid-match.
    if (this.status !== "waiting" && this.status !== "ended") return false;
    return this.players.size === this.requiredPlayers();
  }

  addPlayer(
    playerId: string,
    name: string,
    uuid: string | null,
    ws: WebSocket,
    remoteAddr: string | null = null,
  ): PlayerSession | null {
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
    const session: PlayerSession = {
      id: playerId, name, side, uuid, ws, elo, gamesPlayed,
      disconnectedAt: null, forfeitTimer: null, remoteAddr,
      lastClaimAt: null,
    };
    this.players.set(playerId, session);
    this.touchEmpty();
    if (this.hostId === null) this.hostId = playerId;
    return session;
  }

  /**
   * C3: Look up a player by UUID currently in a "disconnected, awaiting reconnect"
   * state. Used by the join path to restore an in-progress match after a brief
   * network blip rather than awarding the match to the opponent.
   */
  findDisconnectedByUuid(uuid: string): PlayerSession | null {
    for (const p of this.players.values()) {
      if (p.uuid === uuid && p.disconnectedAt !== null) return p;
    }
    return null;
  }

  /**
   * C3: returns true iff there is any in-flight grace timer in this room (player
   * disconnected mid-match, hasn't reconnected yet). Used by the WS close handler
   * to decide whether the room is salvageable or should be cleaned up.
   */
  hasPendingReconnect(): boolean {
    for (const p of this.players.values()) {
      if (p.disconnectedAt !== null) return true;
    }
    return false;
  }

  /**
   * C3: replace a disconnected session's WS with a fresh one. Returns the
   * restored session. Caller is responsible for sending fresh snapshots.
   */
  reconnectPlayer(playerId: string, ws: WebSocket, remoteAddr: string | null): PlayerSession | null {
    const session = this.players.get(playerId);
    if (!session || session.disconnectedAt === null) return null;
    session.ws = ws;
    session.disconnectedAt = null;
    session.remoteAddr = remoteAddr ?? session.remoteAddr;
    if (session.forfeitTimer) {
      clearTimeout(session.forfeitTimer);
      session.forfeitTimer = null;
    }
    return session;
  }

  /** Lookup by playerId — used by the connection layer for reconnect routing. */
  getPlayer(playerId: string): PlayerSession | null {
    return this.players.get(playerId) ?? null;
  }

  /** Iterator over current player sessions — read-only access for the registry. */
  *players_iter(): IterableIterator<PlayerSession> {
    yield* this.players.values();
  }

  /**
   * Disconnect handler. Behaviour differs by match state:
   *  - waiting/ended: immediately remove the player from the room.
   *  - playing: mark the player as `disconnected` and start a [RECONNECT_GRACE_MS]
   *    forfeit timer. If they reconnect (via [reconnectPlayer]) before it fires,
   *    the timer is cancelled. Otherwise the timer settles the match for the
   *    opponent, same as before. This blunts the attack where a third party
   *    knocks a player offline to claim a free ELO win — momentary blips are
   *    forgiven.
   * Returns {wasPlaying} so the caller can decide on room cleanup.
   */
  removePlayer(playerId: string): { wasPlaying: boolean; remaining: PlayerSession | null; pendingReconnect: boolean } {
    const removed = this.players.get(playerId);
    if (!removed) return { wasPlaying: false, remaining: null, pendingReconnect: false };

    if (this.status === "playing") {
      // C3: don't tear down — start the grace timer instead.
      if (removed.disconnectedAt === null) {
        removed.disconnectedAt = Date.now();
        removed.forfeitTimer = setTimeout(() => {
          // Re-check that the player didn't reconnect in the meantime.
          if (removed.disconnectedAt === null) return;
          if (this.status !== "playing") return;
          this.forfeitDisconnected(playerId);
        }, RECONNECT_GRACE_MS);
      }
      const remaining = [...this.players.values()].find((p) => p.id !== playerId && p.disconnectedAt === null) ?? null;
      return { wasPlaying: true, remaining, pendingReconnect: true };
    }

    this.players.delete(playerId);
    this.touchEmpty();
    const remaining = this.players.values().next().value ?? null;
    if (this.hostId === playerId) this.hostId = remaining?.id ?? null;
    return { wasPlaying: false, remaining, pendingReconnect: false };
  }

  /** Hard-kick a player session without any grace — used by leave_room and forfeit timer. */
  forceRemovePlayer(playerId: string): PlayerSession | null {
    const session = this.players.get(playerId);
    if (!session) return null;
    if (session.forfeitTimer) {
      clearTimeout(session.forfeitTimer);
      session.forfeitTimer = null;
    }
    this.players.delete(playerId);
    this.touchEmpty();
    if (this.hostId === playerId) {
      const remaining = this.players.values().next().value ?? null;
      this.hostId = remaining?.id ?? null;
    }
    return session;
  }

  /**
   * C3: called from the grace timer. Settles as a disconnect-forfeit.
   *
   * Bug fix: previously this returned early when `status !== "playing"` BEFORE
   * removing the session from `this.players`. If both players were disconnected
   * and the first forfeit timer flipped status to "ended", the second timer
   * left its session stranded in the map forever — the room could never be
   * GC'd because size > 0. Always remove the session first; only the settle/
   * broadcast logic is gated on still-playing.
   */
  private forfeitDisconnected(playerId: string): void {
    const removed = this.players.get(playerId);
    if (!removed) return;

    this.players.delete(playerId);
    this.touchEmpty();

    if (this.status !== "playing") return;

    const remaining = [...this.players.values()].find((p) => p.disconnectedAt === null) ?? null;
    if (this.hostId === playerId) this.hostId = remaining?.id ?? null;
    const winnerSide = remaining?.side ?? null;
    const eloChanges = this.settleMatch(winnerSide, "disconnect", removed);
    this.status = "ended";
    this.broadcast({
      type: "match_end",
      winner: winnerSide,
      reason: "disconnect",
      eloChanges,
    });
  }

  addSpectator(ws: WebSocket): boolean {
    // H3: hard cap so a single attacker can't fan-out broadcasts indefinitely.
    if (this.spectators.size >= MAX_SPECTATORS_PER_ROOM) return false;
    this.spectators.add(ws);
    this.sendRoomState(ws, null);
    if (this.status === "playing" || this.status === "ended") {
      this.sendMatchSnapshot(ws, null);
    }
    return true;
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
    // Re-roll the seed each time so a rematch in the same room generates a
    // fresh world (otherwise both clients would re-create the SAME terrain and
    // hit name conflicts on disk).
    this.seed = randomSeed64();
    const rand = mulberry32(Number(this.seed & 0xffffffffn));
    this.board = buildBoard(rand);
    this.claimedMap.clear();
    this.claimedLog.length = 0;
    this.startedAt = Date.now();
    this.status = "playing";
    this.readyPlayers.clear();
    this.matchActiveAt = null;
    this.matchSettled = false;
    // Reset per-player session match flags so the anti-rapid-fire gate and
    // disconnect grace don't carry over from the previous match.
    for (const p of this.players.values()) {
      p.lastClaimAt = null;
      p.disconnectedAt = null;
      if (p.forfeitTimer) { clearTimeout(p.forfeitTimer); p.forfeitTimer = null; }
    }
    for (const p of this.players.values()) this.sendMatchSnapshot(p.ws, p);
    for (const sp of this.spectators) this.sendMatchSnapshot(sp, null);
  }

  markReady(playerId: string): void {
    if (this.status !== "playing" || !this.board) return;
    if (!this.players.has(playerId)) return;
    if (this.matchActiveAt !== null) return;
    this.readyPlayers.add(playerId);
    if (this.readyPlayers.size >= this.players.size) {
      // 5s pre-match countdown — gives both players time to settle in the
      // freshly-loaded world before claims can start firing.
      const startsAt = Date.now() + 5000;
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
    if (player.disconnectedAt !== null) return; // mid-reconnect, ignore
    if (this.status !== "playing" || !this.board) {
      this.send(player.ws, { type: "claim_rejected", tileId, reason: "match_not_active" });
      return;
    }
    if (this.matchActiveAt === null || Date.now() < this.matchActiveAt) {
      this.send(player.ws, { type: "claim_rejected", tileId, reason: "countdown" });
      return;
    }

    // C2 (partial): time-gate claims to defeat the trivial "send all 25 claims at t=0"
    // cheat-client. These thresholds are conservative — no human first-claim
    // happens in <15s of in-world time, and even the easiest back-to-back
    // missions take more than 1s.
    const now = Date.now();
    if (now - this.matchActiveAt < MIN_TIME_TO_FIRST_CLAIM_MS) {
      this.send(player.ws, { type: "claim_rejected", tileId, reason: "too_fast" });
      console.warn(`[room ${this.code}] suspicious early claim by ${player.name} (${now - this.matchActiveAt}ms after start)`);
      return;
    }
    if (player.lastClaimAt !== null && now - player.lastClaimAt < MIN_INTERVAL_BETWEEN_CLAIMS_MS) {
      this.send(player.ws, { type: "claim_rejected", tileId, reason: "too_fast" });
      console.warn(`[room ${this.code}] suspicious rapid claim by ${player.name} (${now - player.lastClaimAt}ms gap)`);
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

    const claimedAt = now;
    player.lastClaimAt = claimedAt;
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

    // C1 (partial): self-play guard. If both seats are the same UUID, or both
    // sessions came from the same remote IP, the match is recorded but NOT
    // ELO-rated. UUID self-play is the obvious case (same player both sides);
    // same-IP catches the casual ELO-farmer running two clients on the same
    // machine without a VPN. Genuine LAN siblings get caught too — they can
    // still play, just not rated. Trade-off accepted.
    let effectiveRated = this.settings.rated;
    let unratedReason: string | null = null;
    if (a && b && effectiveRated) {
      if (a.uuid && b.uuid && a.uuid === b.uuid) {
        effectiveRated = false;
        unratedReason = "same_uuid";
      } else if (a.remoteAddr && b.remoteAddr && a.remoteAddr === b.remoteAddr) {
        effectiveRated = false;
        unratedReason = "same_ip";
      }
    }
    if (unratedReason) {
      console.warn(`[room ${this.code}] match force-unrated: ${unratedReason}`);
    }

    const eloChanges: Record<string, EloChange> = {};
    let aBefore: number | null = null, aAfter: number | null = null;
    let bBefore: number | null = null, bAfter: number | null = null;

    if (effectiveRated && a && b) {
      const updA = computeNewElo(a.elo, b.elo, a.gamesPlayed, aScore);
      const updB = computeNewElo(b.elo, a.elo, b.gamesPlayed, bScore);
      aBefore = updA.before; aAfter = updA.after;
      bBefore = updB.before; bAfter = updB.after;
      eloChanges[a.id] = updA;
      eloChanges[b.id] = updB;
    } else if (a && b) {
      aBefore = a.elo; aAfter = a.elo;
      bBefore = b.elo; bAfter = b.elo;
    }

    // M2: bundle the elo-update + match-record writes into a single transaction
    // so partial failures roll back. Without this, a disk-full error mid-way
    // would leave one player's ELO updated and the other's stale (or vice
    // versa) with no audit row.
    try {
      inTransaction(() => {
        if (effectiveRated && a && b) {
          if (a.uuid) applyMatchResult(a.uuid, aAfter!, aScore === 1 ? 1 : aScore === 0 ? -1 : 0);
          if (b.uuid) applyMatchResult(b.uuid, bAfter!, bScore === 1 ? 1 : bScore === 0 ? -1 : 0);
        }
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
          rated: effectiveRated,
        });
      });
      // Reflect rating into the session AFTER the transaction commits so a
      // failure doesn't leave clients seeing a different ELO than the DB.
      if (effectiveRated && a && b) {
        a.elo = aAfter!;
        b.elo = bAfter!;
      }
    } catch (e) {
      console.warn(`[room ${this.code}] settle DB tx failed: ${(e as Error).message}`);
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

  /**
   * C3: after a successful reconnect, push room_state + (if a match is in
   * progress) the current board snapshot to the restored session so the client
   * has up-to-date state. Other players are notified separately via notifyJoin.
   */
  sendReconnectSnapshot(playerId: string): void {
    const session = this.players.get(playerId);
    if (!session) return;
    this.sendRoomState(session.ws, session);
    if (this.status === "playing" || this.status === "ended") {
      this.sendMatchSnapshot(session.ws, session);
    }
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

/**
 * L4: cryptographically-random match seed. `Math.random` is not a CSPRNG and is
 * predictable from a few samples — an attacker who guesses the seed can
 * pre-simulate the whole board to find an optimal mission order. With
 * `crypto.randomBytes` the seed space is effectively unsearchable.
 */
function randomSeed64(): bigint {
  const buf = randomBytes(8);
  return buf.readBigInt64BE(0);
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

  /**
   * C1 (partial): block one UUID from occupying multiple active rooms at once.
   * If the same Minecraft account is already in a different room (even as a
   * disconnected-pending session), we deny the new join — this kills the
   * obvious "two clients with the same UUID for self-play" attempt and also
   * stops a player from straddling two matches.
   *
   * Returns the room they're already in, or null if free to join.
   */
  findRoomContainingUuid(uuid: string): Room | null {
    if (!uuid) return null;
    for (const room of this.rooms.values()) {
      if (room.status === "ended") continue;
      for (const p of room.players_iter()) {
        if (p.uuid === uuid) return room;
      }
    }
    return null;
  }

  /**
   * H1: periodic GC for stale rooms. Deletes any room that has been empty
   * (size==0) for at least `ttlMs`, regardless of status. Catches:
   *  - rooms whose create_room succeeded but addPlayer failed
   *  - rooms where both forfeit timers fired (now also fixed at the source)
   *  - any other edge case where the inline disconnect cleanup didn't run
   *
   * Invoke from a setInterval (e.g. every 30s). Returns the count reaped.
   */
  reapIdle(ttlMs: number): number {
    let n = 0;
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const since = room.idleSince();
      if (since === null) continue;
      if (room.hasPendingReconnect()) continue;
      if (now - since < ttlMs) continue;
      this.rooms.delete(code);
      n++;
    }
    return n;
  }
}
