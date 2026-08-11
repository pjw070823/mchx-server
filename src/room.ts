import { customAlphabet } from "nanoid";
import type { WebSocket } from "ws";
import type {
  BoardTile,
  RoomSettings,
  RoomStatus,
  ServerMessage,
  Side,
  TileId,
} from "./protocol.js";
import { DEFAULT_SETTINGS } from "./protocol.js";
import { DEFAULT_ELO, getOrCreatePlayer } from "./db.js";
import { MatchEngine } from "./match-engine.js";
import { RoomBroadcaster } from "./broadcaster.js";
import { settleMatch } from "./settlement.js";
import { applySettingsPatch, RANKED_SETTINGS } from "./settings-policy.js";
import { tierOf } from "./entitlements.js";
import { toPlayerInfo, type PlayerSession } from "./session.js";
import { DEFAULT_ROOM_CONFIG, type RoomConfig, type RoomOrigin } from "./room-config.js";

export { DEFAULT_ROOM_CONFIG } from "./room-config.js";
export type { RoomConfig, RoomOrigin } from "./room-config.js";

/** Ambiguous glyphs (I, O, 1, 0) are excluded — codes get read aloud and retyped. */
const newRoomCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

/**
 * A room: who is in it, what they've agreed to play, and the lifecycle around a match.
 *
 * Room deliberately does not know the rules of the game, how ratings are computed, or
 * how a message reaches a socket. It delegates:
 *
 *   [MatchEngine]     the board, claim legality, win detection
 *   [settleMatch]     rating maths and persistence
 *   [RoomBroadcaster] fan-out to players and spectators
 *
 * What's left here is the part that is genuinely about a *room*: seats, the host,
 * settings, and deciding what a disconnect means.
 */
export class Room {
  readonly code: string;
  readonly origin: RoomOrigin;
  status: RoomStatus = "waiting";
  hostId: string | null = null;
  settings: RoomSettings;

  private readonly players = new Map<string, PlayerSession>();
  private readonly spectators = new Set<WebSocket>();
  private readonly engine: MatchEngine;
  private readonly bus: RoomBroadcaster;
  private readonly config: RoomConfig;

  /** Guards against settling the same match twice (both forfeit timers firing). */
  private matchSettled = false;

  /**
   * When this room last became empty, or null while occupied. [RoomRegistry.reapIdle]
   * uses it to delete rooms the inline disconnect cleanup missed — create-then-failed
   * joins, spectator-only rooms after a match, and so on. Starts non-null because a
   * freshly constructed room has no players yet.
   */
  private emptiedAt: number | null = Date.now();

  /**
   * When the current match finished, or null if one has never finished here.
   *
   * A custom room goes straight back to `waiting` and empties normally, so [emptiedAt]
   * collects it. A ranked room stays `ended` with both players still seated — which
   * means `size() > 0`, `emptiedAt === null`, and the idle rule can never take it. This
   * is the second hand on the reaper's clock.
   */
  private endedAt: number | null = null;

  /** Fires if the clients never both report `world_ready`. See [beginMatch]. */
  private readyTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<RoomConfig> = {}, origin: RoomOrigin = "custom") {
    this.code = newRoomCode();
    this.origin = origin;
    // Ranked settings are fixed at construction, which is what makes them
    // unbypassable — there is no later point where a client could set them.
    this.settings = origin === "ranked" ? { ...RANKED_SETTINGS } : { ...DEFAULT_SETTINGS };
    this.config = { ...DEFAULT_ROOM_CONFIG, ...config };
    this.engine = new MatchEngine(this.config);
    this.bus = new RoomBroadcaster(this.code, this.players, this.spectators);
  }

  /** The current match's world seed. */
  get seed(): bigint {
    return this.engine.seed;
  }

  // --- seats -------------------------------------------------------------------

  size(): number {
    return this.players.size;
  }

  requiredPlayers(): number {
    return this.settings.gameMode === "2v2" ? 4 : 2;
  }

  /** Idle-TTL probe. The timestamp this room went empty, or null if occupied. */
  idleSince(): number | null {
    return this.emptiedAt;
  }

  /** Reap probe for finished rooms that never emptied. Null until a match ends. */
  endedSince(): number | null {
    return this.status === "ended" ? this.endedAt : null;
  }

  private touchEmpty(): void {
    if (this.players.size === 0) {
      if (this.emptiedAt === null) this.emptiedAt = Date.now();
    } else {
      this.emptiedAt = null;
    }
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
      disconnectedAt: null, forfeitTimer: null, remoteAddr, lastClaimAt: null,
    };
    this.players.set(playerId, session);
    this.touchEmpty();
    // Ranked rooms are run by the matchmaker and have no host to promote.
    if (this.origin === "custom" && this.hostId === null) this.hostId = playerId;
    return session;
  }

  getPlayer(playerId: string): PlayerSession | null {
    return this.players.get(playerId) ?? null;
  }

  *players_iter(): IterableIterator<PlayerSession> {
    yield* this.players.values();
  }

  /** A seat being held open for a reconnect, matched by account. */
  findDisconnectedByUuid(uuid: string): PlayerSession | null {
    for (const p of this.players.values()) {
      if (p.uuid === uuid && p.disconnectedAt !== null) return p;
    }
    return null;
  }

  /** True while any seat is mid-grace-period. Stops the reaper taking the room. */
  hasPendingReconnect(): boolean {
    for (const p of this.players.values()) {
      if (p.disconnectedAt !== null) return true;
    }
    return false;
  }

  /** Attach a fresh socket to a held seat and cancel its pending forfeit. */
  reconnectPlayer(playerId: string, ws: WebSocket, remoteAddr: string | null): PlayerSession | null {
    const session = this.players.get(playerId);
    if (!session || session.disconnectedAt === null) return null;
    session.ws = ws;
    session.disconnectedAt = null;
    session.remoteAddr = remoteAddr ?? session.remoteAddr;
    this.cancelForfeitTimer(session);
    return session;
  }

  /**
   * The socket closed. Mid-match this holds the seat and starts the grace timer;
   * otherwise the player simply leaves.
   */
  removePlayer(playerId: string): { wasPlaying: boolean; remaining: PlayerSession | null; pendingReconnect: boolean } {
    const removed = this.players.get(playerId);
    if (!removed) return { wasPlaying: false, remaining: null, pendingReconnect: false };

    if (this.status === "playing") {
      if (removed.disconnectedAt === null) {
        removed.disconnectedAt = Date.now();
        removed.forfeitTimer = setTimeout(() => {
          if (removed.disconnectedAt === null) return; // reconnected in time
          // Deliberately NOT gated on `status === "playing"`. When both players drop,
          // the first timer settles the match and flips the room back to "waiting";
          // a status check here would then make the second timer return before
          // deleting its seat, leaving a session with a dead socket in the map
          // forever — size() never reaches 0, emptiedAt stays null, and reapIdle
          // skips the room for the life of the process. endByForfeit already removes
          // the seat first and only then decides whether a match needs settling.
          this.endByForfeit(playerId, "disconnect");
        }, this.config.reconnectGraceMs);
      }
      const remaining = [...this.players.values()]
        .find((p) => p.id !== playerId && p.disconnectedAt === null) ?? null;
      return { wasPlaying: true, remaining, pendingReconnect: true };
    }

    this.players.delete(playerId);
    this.touchEmpty();
    const remaining = this.players.values().next().value ?? null;
    if (this.hostId === playerId) this.hostId = remaining?.id ?? null;
    return { wasPlaying: false, remaining, pendingReconnect: false };
  }

  /** Drop a seat immediately, no grace. Used by explicit leaves. */
  forceRemovePlayer(playerId: string): PlayerSession | null {
    const session = this.players.get(playerId);
    if (!session) return null;
    this.cancelForfeitTimer(session);
    this.players.delete(playerId);
    this.touchEmpty();
    if (this.hostId === playerId) {
      this.hostId = this.players.values().next().value?.id ?? null;
    }
    return session;
  }

  /**
   * A deliberate mid-match exit — the in-game "게임 포기하기" button, which Save&Quits
   * and lets the world-exit hook send `leave_room`. No grace period: this is a choice,
   * not a network problem.
   */
  forfeitByLeave(playerId: string): void {
    this.endByForfeit(playerId, "forfeit");
  }

  /**
   * Remove a player and, if a match was running, settle it for whoever is left.
   *
   * The session is always deleted *before* the still-playing check. Gating first would
   * strand a seat whenever a second forfeit timer fires after the first already ended
   * the match, and a stranded seat keeps `size()` above zero forever — which in turn
   * makes the room un-reapable.
   */
  private endByForfeit(playerId: string, reason: "forfeit" | "disconnect"): void {
    const removed = this.players.get(playerId);
    if (!removed) return;

    this.cancelForfeitTimer(removed);
    this.players.delete(playerId);
    this.touchEmpty();

    if (this.status !== "playing") {
      if (this.hostId === playerId) {
        this.hostId = this.players.values().next().value?.id ?? null;
      }
      return;
    }

    const remaining = [...this.players.values()].find((p) => p.disconnectedAt === null) ?? null;
    if (this.hostId === playerId) this.hostId = remaining?.id ?? null;
    this.endMatch(remaining?.side ?? null, reason, removed);
  }

  private cancelForfeitTimer(session: PlayerSession): void {
    if (session.forfeitTimer) {
      clearTimeout(session.forfeitTimer);
      session.forfeitTimer = null;
    }
  }

  // --- spectators ----------------------------------------------------------------

  addSpectator(ws: WebSocket): boolean {
    if (this.spectators.size >= this.config.maxSpectators) return false;
    this.spectators.add(ws);
    this.sendRoomState(ws, null);
    if (this.status === "playing" || this.status === "ended") this.sendMatchSnapshot(ws, null);
    return true;
  }

  removeSpectator(ws: WebSocket): void {
    this.spectators.delete(ws);
  }

  // --- settings ---------------------------------------------------------------------

  /**
   * Host-only, pre-match only. Returns false if the caller wasn't allowed to ask —
   * fields they simply couldn't afford are skipped, not treated as failure.
   */
  updateSettings(playerId: string, partial: Partial<RoomSettings>): boolean {
    // Ranked rooms take their settings from the ladder, not from a player.
    if (this.origin !== "custom") return false;
    if (this.hostId !== playerId) return false;
    if (this.status !== "waiting") return false;

    const requester = this.players.get(playerId);
    const { settings, deniedByTier } = applySettingsPatch(
      this.settings, partial, tierOf(requester?.uuid ?? null),
    );
    if (deniedByTier.length > 0) {
      console.log(`[room ${this.code}] settings denied by tier: ${deniedByTier.join(", ")}`);
    }
    this.settings = settings;
    return true;
  }

  // --- match lifecycle -----------------------------------------------------------------

  /**
   * Startable from `waiting` (first match) and `ended` (rematch), never mid-match — the
   * host mashing 시작 must not restart a running game.
   */
  isReadyToStart(): boolean {
    if (this.status !== "waiting" && this.status !== "ended") return false;
    return this.players.size === this.requiredPlayers();
  }

  startMatchByHost(playerId: string): { ok: boolean; reason?: string } {
    if (this.origin !== "custom" || this.hostId !== playerId) return { ok: false, reason: "not_host" };
    if (!this.isReadyToStart()) return { ok: false, reason: "not_ready" };
    this.beginMatch();
    return { ok: true };
  }

  /**
   * Start without a host. Reserved for the matchmaker, which builds a full room and
   * starts it itself; there is no player to authorise it.
   */
  start(): { ok: boolean; reason?: string } {
    if (!this.isReadyToStart()) return { ok: false, reason: "not_ready" };
    this.beginMatch();
    return { ok: true };
  }

  private beginMatch(): void {
    this.engine.begin();
    this.status = "playing";
    this.matchSettled = false;
    this.endedAt = null;
    // Clear per-match session state so gates and grace timers don't carry over.
    for (const p of this.players.values()) {
      p.lastClaimAt = null;
      p.disconnectedAt = null;
      this.cancelForfeitTimer(p);
    }
    for (const p of this.players.values()) this.sendMatchSnapshot(p.ws, p);
    for (const sp of this.spectators) this.sendMatchSnapshot(sp, null);
    this.armReadyTimeout();
  }

  /**
   * Give up on a match nobody can start.
   *
   * A client whose socket is fine but whose world never generates simply never sends
   * `world_ready`, and there was no deadline on that at all — the opponent sat on the
   * waiting screen forever. Custom rooms had the same hole, but ranked makes it
   * reachable by a stranger you were paired with, so it needs an answer.
   */
  private armReadyTimeout(): void {
    this.clearReadyTimeout();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.status !== "playing" || this.engine.isArmed) return;

      const stalled = [...this.players.values()].filter((p) => !this.engine.isReady(p.id));
      // Everyone stalled: no one to award it to, so end it with no winner.
      if (stalled.length === this.players.size) {
        console.warn(`[room ${this.code}] no world ready in time — ending with no winner`);
        this.endMatch(null, "disconnect", null);
        return;
      }
      const loser = stalled[0]!;
      console.warn(`[room ${this.code}] ${loser.name} never reported world_ready — forfeiting`);
      this.endByForfeit(loser.id, "disconnect");
    }, this.config.readyTimeoutMs);
  }

  private clearReadyTimeout(): void {
    if (this.readyTimer === null) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  /** A player's world finished loading. Arms the countdown once everyone is in. */
  markReady(playerId: string): void {
    if (this.status !== "playing") return;
    if (!this.players.has(playerId)) return;
    const startsAt = this.engine.markReady(playerId, this.players.size);
    if (startsAt === null) return;
    this.clearReadyTimeout();
    this.bus.toEveryone({ type: "countdown_start", startsAt });
  }

  attemptClaim(playerId: string, tileId: TileId, missionId: string): void {
    const player = this.players.get(playerId);
    if (!player || !player.side) return;
    if (player.disconnectedAt !== null) return; // mid-reconnect
    if (this.status !== "playing") {
      this.bus.send(player.ws, { type: "claim_rejected", tileId, reason: "match_not_active" });
      return;
    }

    const outcome = this.engine.attemptClaim(player, tileId, missionId);
    if (!outcome.ok) {
      if (outcome.reason === "too_fast") {
        console.warn(`[room ${this.code}] suspicious claim rate from ${player.name}`);
      }
      this.bus.send(player.ws, { type: "claim_rejected", tileId, reason: outcome.reason });
      return;
    }

    this.bus.toEveryone({ type: "tile_claimed", ...outcome.claim });
    if (outcome.winningSide) this.endMatch(outcome.winningSide, "connection", null);
  }

  /**
   * Settle, announce, and hand the room back for a rematch.
   *
   * `quitter` is the session that left, when the match ended because they did — it has
   * already been removed from `players` but its rating still has to move.
   */
  private endMatch(
    winnerSide: Side | null,
    reason: "connection" | "forfeit" | "disconnect",
    quitter: PlayerSession | null,
  ): void {
    this.clearReadyTimeout();
    const eloChanges = this.matchSettled ? {} : this.settle(winnerSide, reason, quitter);
    this.matchSettled = true;
    this.status = "ended";
    this.endedAt = Date.now();
    this.bus.toEveryone({ type: "match_end", winner: winnerSide, reason, eloChanges });

    // Ranked rooms are one-shot. Returning to `waiting` would put a room whose code both
    // players know back on the joinable list, and the ladder decides pairings, not a code.
    // Clients still need the status change, hence the notify either way.
    if (this.origin === "custom") this.resetForRematch();
    else this.notifyJoin();
  }

  private settle(
    winnerSide: Side | null,
    reason: "connection" | "forfeit" | "disconnect",
    quitter: PlayerSession | null,
  ) {
    const all = [...this.players.values()];
    if (quitter) all.push(quitter);
    return settleMatch({
      roomCode: this.code,
      seed: this.engine.seed,
      startedAt: this.engine.startedAt,
      board: this.engine.board ?? [],
      claimedLog: this.engine.claimedLog,
      settings: this.settings,
      a: all.find((s) => s.side === "A") ?? null,
      b: all.find((s) => s.side === "B") ?? null,
      winnerSide,
      reason,
    });
  }

  /**
   * Return to `waiting` so the room is immediately rematch-ready.
   *
   * Left at `ended`, the room was hidden from `/api/rooms`, refused new joins and
   * reconnects (both require `waiting`), and left clients on stale post-match state so
   * the host couldn't start again. The board and claim log stay intact so spectators
   * keep seeing the final position; [beginMatch] rebuilds everything anyway.
   */
  private resetForRematch(): void {
    this.status = "waiting";
    this.notifyJoin();
  }

  // --- outbound snapshots ---------------------------------------------------------------

  notifyJoin(): void {
    for (const p of this.players.values()) this.sendRoomState(p.ws, p);
    for (const sp of this.spectators) this.sendRoomState(sp, null);
  }

  /** After a reconnect, restore the returning client's view of room and board. */
  sendReconnectSnapshot(playerId: string): void {
    const session = this.players.get(playerId);
    if (!session) return;
    this.sendRoomState(session.ws, session);
    if (this.status === "playing" || this.status === "ended") {
      this.sendMatchSnapshot(session.ws, session);
    }
  }

  broadcastChat(playerId: string, text: string): void {
    const sender = this.players.get(playerId);
    if (!sender) return;
    this.bus.toEveryoneExcept(playerId, {
      type: "chat_message", senderId: playerId, senderName: sender.name, text,
    });
  }

  broadcastWorldEvent(playerId: string, kind: "death" | "advancement" | "forfeit", text: string): void {
    const sender = this.players.get(playerId);
    if (!sender) return;
    this.bus.toEveryoneExcept(playerId, {
      type: "world_event_message", senderId: playerId, senderName: sender.name, kind, text,
    });
  }

  private sendRoomState(ws: WebSocket, viewer: PlayerSession | null): void {
    const sessions = [...this.players.values()];
    // Spectators have no seat, so they get seat 0 as "you" and seat 1 as "opponent".
    // A cleaner protocol would send a viewer-independent players[] list.
    const you = viewer ?? sessions[0] ?? null;
    const opp = viewer
      ? sessions.find((s) => s.id !== viewer.id) ?? null
      : sessions[1] ?? null;

    this.bus.send(ws, {
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
    if (!this.engine.board || this.engine.startedAt === null) return;
    this.bus.send(ws, {
      type: "match_start",
      // Spectators get no seed: it regenerates the entire board offline, so a player
      // watching their own match on a second screen would see every mission in advance.
      seed: viewer ? this.engine.seed : null,
      yourSide: viewer?.side ?? null,
      board: this.engine.board,
      claimed: [...this.engine.claimedLog],
      settings: this.settings,
      startsAt: this.engine.startedAt,
    });
  }

  /** Serialisable snapshot for the public `/api/rooms` listing. No sockets. */
  summary(): RoomSummary {
    let claimedA = 0;
    let claimedB = 0;
    for (const side of this.engine.claimedMap.values()) {
      if (side === "A") claimedA++;
      else claimedB++;
    }
    return {
      code: this.code,
      status: this.status,
      origin: this.origin,
      capacity: this.requiredPlayers(),
      settings: this.settings,
      hostId: this.hostId,
      // 진행 상황 — 목록 화면이 "얼마나 진행됐나"를 보여주려면 필요합니다.
      claimedA,
      claimedB,
      boardSize: this.engine.board?.length ?? 0,
      startedAt: this.engine.startedAt,
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
}

export interface RoomSummary {
  code: string;
  status: RoomStatus;
  /** 랭크 방인지 커스텀 방인지. 목록에서 태그를 정확히 붙이려면 필요합니다. */
  origin: RoomOrigin;
  capacity: number;
  settings: RoomSettings;
  hostId: string | null;
  /** 각 진영이 가져간 칸 수. 대기 중인 방은 둘 다 0입니다. */
  claimedA: number;
  claimedB: number;
  /** 이번 매치의 전체 칸 수(보통 25). 보드가 없으면 0. */
  boardSize: number;
  /** 매치 시작 시각(ms). 대기 중이면 null — 목록의 경과 시간 표시에 씁니다. */
  startedAt: number | null;
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

  create(config: Partial<RoomConfig> = {}, origin: RoomOrigin = "custom"): Room {
    let room: Room;
    do {
      room = new Room(config, origin);
    } while (this.rooms.has(room.code));
    this.rooms.set(room.code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  delete(code: string): void {
    // Uppercase to match `get`. Generated codes are already uppercase so this is a
    // no-op for every current caller, but the asymmetry was a trap left lying around.
    this.rooms.delete(code.toUpperCase());
  }

  /** Rooms worth showing on the public listing. */
  listActive(): RoomSummary[] {
    return [...this.rooms.values()]
      .filter((r) => r.status !== "ended")
      .map((r) => r.summary());
  }

  /**
   * The room a UUID currently occupies, if any — including a seat held open for a
   * reconnect. Blocks one account from straddling two rooms, which is both the obvious
   * self-play setup and a way to end up forfeiting a match you forgot you were in.
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
   * Delete rooms that have sat empty for `ttlMs`. The inline disconnect cleanup handles
   * the normal path; this catches what it misses — a create whose first join failed, or
   * a room everyone dropped out of at once. Rooms awaiting a reconnect are spared.
   *
   * The second rule covers finished rooms that never went empty. A ranked room stays
   * `ended` with both players still seated until their clients send `leave_room`, so
   * `idleSince()` is null the whole time and the first rule can never reach it — left
   * alone it would live as long as the process. Custom rooms never sit in `ended`
   * (they return to `waiting`), so in practice this only ever fires for ranked.
   */
  reapIdle(ttlMs: number): number {
    let n = 0;
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.hasPendingReconnect()) continue;

      const idle = room.idleSince();
      const ended = room.endedSince();
      const since = idle ?? ended;
      if (since === null) continue;
      if (now - since < ttlMs) continue;
      this.rooms.delete(code);
      n++;
    }
    return n;
  }
}

export type { PlayerSession } from "./session.js";
export type { BoardTile };
