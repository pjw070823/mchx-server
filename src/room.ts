import { customAlphabet } from "nanoid";
import type { WebSocket } from "ws";
import type {
  BoardTile,
  MatchWorld,
  RoomPlayer,
  RoomSettings,
  RoomStatus,
  ServerMessage,
  Side,
  TileId,
} from "./protocol.js";
import { DEFAULT_SETTINGS, PROTOCOL_VERSION, TEAM_PROTOCOL } from "./protocol.js";
import { relayHub, type RelayLink } from "./relay.js";
import { seedPool, type PoolSeed } from "./seed-pool.js";
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

  /**
   * Whether the match under way was started by one player on their own.
   *
   * Decided once, when the match begins, from who was seated at that instant. It cannot
   * be re-derived later from the head count: a two-player match that one side leaves is
   * also down to one seat, and that is a forfeit with a winner, not a solo run.
   */
  private solo = false;

  /** Hands out [PlayerSession.seatedAt]. */
  private seatCounter = 0;

  /** The pool seed the match under way is being played on, or null if it was rolled. */
  private poolSeed: PoolSeed | null = null;

  /**
   * Where each player plays the match under way.
   *
   * Only teams of two appear here: everybody else has a world of their own, which is the
   * absence of an entry. Host and guest of one team hold the same link, and that shared
   * reference is also how "these two are in the same world" is asked.
   */
  private readonly worlds = new Map<string, TeamWorldSeat>();

  /** Closes the last match's links once its players have had time to leave the world. */
  private linkTimer: NodeJS.Timeout | null = null;

  /**
   * Players who have asked to give up and are waiting on their teammate.
   *
   * A team concedes together or not at all. One player pressing the button used to end
   * the match for both, and the other found out from the result screen.
   */
  private readonly forfeitVotes = new Set<string>();

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

  /**
   * Whether a client speaking [protocol] can play in this room as it is set up now.
   *
   * A 2v2 room needs every client to understand being a guest in a teammate's world. One
   * that does not would be dealt that role, ignore it, and sit in a world of its own for
   * the whole match — unable to help its team and unaware of it.
   */
  canSeat(protocol: number): boolean {
    return this.settings.gameMode !== "2v2" || protocol >= TEAM_PROTOCOL;
  }

  addPlayer(
    playerId: string,
    name: string,
    uuid: string | null,
    ws: WebSocket,
    remoteAddr: string | null = null,
    protocol: number = PROTOCOL_VERSION,
  ): PlayerSession | null {
    if (this.players.size >= this.requiredPlayers()) return null;
    if (this.status !== "waiting") return null;
    if (!this.canSeat(protocol)) return null;

    // Take the side nobody is sitting on, rather than deriving it from the head count.
    // Counting was wrong the moment a seat was vacated and refilled: A leaving left one
    // player on B, and the next arrival counted one occupant and took B as well. Two
    // players on B, none on A, and the match still started — every claim went to the same
    // side, so B could win alone and A could not win at all.
    const side = this.freeSide();
    if (!side) return null;

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
      protocol, seatedAt: ++this.seatCounter,
    };
    this.players.set(playerId, session);
    this.touchEmpty();
    // Ranked rooms are run by the matchmaker and have no host to promote.
    if (this.origin === "custom" && this.hostId === null) this.hostId = playerId;
    return session;
  }

  /**
   * The side a new arrival goes to: the emptier one, A on a tie, or null when both are
   * full.
   *
   * In a 1v1 that is "the colour nobody holds". In a 2v2 it fills the teams evenly, so
   * four strangers joining in a row land two and two without anybody choosing — and a
   * player who wants the other team can still move there with [chooseTeam].
   */
  private freeSide(): Side | null {
    const a = this.membersOf("A").length;
    const b = this.membersOf("B").length;
    const order: readonly Side[] = a <= b ? ["A", "B"] : ["B", "A"];
    const cap = this.seatsPerSide();
    return order.find((side) => (side === "A" ? a : b) < cap) ?? null;
  }

  private seatsPerSide(): number {
    return this.settings.gameMode === "2v2" ? 2 : 1;
  }

  /** Everyone on [side], in the order they sat down on it. */
  private membersOf(side: Side): PlayerSession[] {
    return [...this.players.values()]
      .filter((p) => p.side === side)
      .sort((x, y) => x.seatedAt - y.seatedAt);
  }

  /**
   * Move to the other team, if it has room.
   *
   * Pre-match and custom rooms only. The mover goes to the back of the team they join:
   * whoever was already there keeps the world, because they have been told it is theirs.
   */
  chooseTeam(playerId: string, side: Side): boolean {
    if (this.origin !== "custom" || this.status !== "waiting") return false;
    const player = this.players.get(playerId);
    if (!player || player.side === side) return false;
    if (this.membersOf(side).length >= this.seatsPerSide()) return false;
    player.side = side;
    player.seatedAt = ++this.seatCounter;
    return true;
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
   * Concede the match but stay seated.
   *
   * [forfeitByLeave] removes the player, because there the forfeit is a side effect of
   * leaving. Here it is the whole intent: the match is settled for the opponent and both
   * seats are left exactly as they were, so a custom room can be played again without
   * anyone re-entering a code.
   */
  forfeitMatch(playerId: string): boolean {
    if (this.status !== "playing") return false;
    const quitter = this.players.get(playerId);
    if (!quitter || !quitter.side) return false;

    // With a teammate, this is a request, and it takes both. Asked of whoever is seated
    // on the side now, which mid-match is whoever started on it: a seat only empties by
    // ending the match.
    const team = this.membersOf(quitter.side);
    if (team.length > 1) {
      if (!this.forfeitVotes.has(playerId)) {
        this.forfeitVotes.add(playerId);
        if (!team.every((p) => this.forfeitVotes.has(p.id))) {
          this.sendForfeitVotes(quitter.side);
          return true;
        }
      } else if (!team.every((p) => this.forfeitVotes.has(p.id))) {
        return true; // already asked, still waiting
      }
    }

    // Conceding hands the match to the other side — when there is one. A solo run has
    // nobody to hand it to, and naming the empty side the winner would put a result in
    // the archive that says an absent player won.
    const winner: Side | null = this.solo ? null : quitter.side === "A" ? "B" : "A";
    this.endMatch(winner, "forfeit", null);
    return true;
  }

  /** Withdraw a request to give up that the teammate has not yet joined. */
  cancelForfeit(playerId: string): void {
    if (this.status !== "playing") return;
    const player = this.players.get(playerId);
    if (!player || !player.side) return;
    if (this.forfeitVotes.delete(playerId)) this.sendForfeitVotes(player.side);
  }

  /** Tell one team — and nobody else — who on it is asking to give up. */
  private sendForfeitVotes(side: Side): void {
    const team = this.membersOf(side);
    const voters = team.filter((p) => this.forfeitVotes.has(p.id)).map((p) => p.id);
    for (const p of team) this.bus.send(p.ws, { type: "forfeit_vote", voters });
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

    // The other side wins — if anybody on it is still here. Asked about the side rather
    // than about "whoever is left", because in a team match the one left may be the
    // leaver's own teammate: a team loses when either of its players goes, and its
    // remaining member must not be handed the match for it.
    const other: Side | null = removed.side === "A" ? "B" : removed.side === "B" ? "A" : null;
    const otherPresent = other !== null &&
      [...this.players.values()].some((p) => p.side === other && p.disconnectedAt === null);
    this.endMatch(otherPresent ? other : null, reason, removed);
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
    // Someone who starts watching mid-match missed the broadcast that says when play
    // opened, and without it their clock can only count from when the host pressed start.
    if (this.status === "playing") this.sendCountdownIfArmed(ws);
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

    // A mode the people already seated cannot play is dropped from the patch, like a
    // field the host cannot afford: the rest of what they asked for still applies.
    const patch = { ...partial };
    if (patch.gameMode && patch.gameMode !== this.settings.gameMode && !this.fits(patch.gameMode)) {
      delete patch.gameMode;
    }

    const requester = this.players.get(playerId);
    const { settings, deniedByTier } = applySettingsPatch(
      this.settings, patch, tierOf(requester?.uuid ?? null),
    );
    if (deniedByTier.length > 0) {
      console.log(`[room ${this.code}] settings denied by tier: ${deniedByTier.join(", ")}`);
    }
    const modeChanged = settings.gameMode !== this.settings.gameMode;
    this.settings = settings;
    if (modeChanged) this.spreadAcrossSides();
    return true;
  }

  /** Whether the players seated right now could play [mode]. */
  private fits(mode: RoomSettings["gameMode"]): boolean {
    if (mode === "1v1") return this.players.size <= 2;
    for (const p of this.players.values()) {
      if (p.protocol < TEAM_PROTOCOL) return false;
    }
    return true;
  }

  /**
   * Going back to 1v1 with two teammates seated: put them opposite each other.
   *
   * Otherwise the room holds two players on one side with a seat limit of one, and the
   * match that starts is a solo run for two with nobody to play against.
   */
  private spreadAcrossSides(): void {
    if (this.settings.gameMode !== "1v1") return;
    for (const side of ["A", "B"] as const) {
      const members = this.membersOf(side);
      const moved = members[1];
      if (!moved) continue;
      moved.side = side === "A" ? "B" : "A";
      moved.seatedAt = ++this.seatCounter;
    }
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
    if (!this.isReadyToStart() && !this.canStartShort()) return { ok: false, reason: "not_ready" };
    // Refused, not quietly played on a random seed. The room asked for a filtered seed
    // and everybody in it can see that it did; a match that silently was not one would
    // be found out a quarter of an hour in, by players looking for a village.
    if (this.settings.seedFilter && seedPool.size() === 0) return { ok: false, reason: "seed_pool_empty" };
    this.beginMatch();
    return { ok: true };
  }

  /**
   * Whether a custom room's host may start with seats still empty.
   *
   * A 1v1 room may start with one player: that is a solo run. A 2v2 room may start with
   * anyone at all in it — two against one, one against one, or one team by itself, which
   * is a solo run for that team. What kind of match it is follows from who was seated,
   * not from the mode's name; see [beginMatch].
   *
   * Reached only through [startMatchByHost], which has already established that this is
   * a custom room and the caller is its host. The matchmaker's [start] does not come
   * through here, so a ranked room still needs both of its players.
   */
  private canStartShort(): boolean {
    if (this.status !== "waiting" && this.status !== "ended") return false;
    if (this.settings.gameMode === "2v2") return this.players.size >= 1;
    return this.players.size === 1;
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
    // Only where the setting can be set. A ranked room's settings are the fixed preset,
    // which has it off, so this is belt and braces — but the pool must never be what a
    // rated match is played on, and that is worth saying twice.
    this.poolSeed = this.origin === "custom" && this.settings.seedFilter ? seedPool.pick() : null;
    this.engine.begin(this.poolSeed?.seed);
    this.status = "playing";
    // One side with nobody on it, not one player in the room: two teammates with the
    // other team empty have no opponent either.
    this.solo = this.membersOf("A").length === 0 || this.membersOf("B").length === 0;
    this.forfeitVotes.clear();
    this.assignWorlds();
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
   * Decide where everybody plays, and open a relay link for each team that shares.
   *
   * A team of two plays in one world. It runs in the game of whoever sat down on that
   * side first — the seat marked for it on the room screen — and the other joins it. A
   * side with one player on it needs none of this.
   */
  private assignWorlds(): void {
    this.closeLinks();
    for (const side of ["A", "B"] as const) {
      const [host, ...guests] = this.membersOf(side);
      if (!host || guests.length === 0) continue;

      const hostId = host.id;
      const link = relayHub.open((streamId) => {
        // Looked up when it fires, not captured: a host who reconnected mid-match is
        // the same seat on a different socket.
        const session = this.players.get(hostId);
        if (session) this.bus.send(session.ws, { type: "relay_stream", streamId });
      });
      this.worlds.set(hostId, { role: "host", link, open: false });
      for (const guest of guests) this.worlds.set(guest.id, { role: "guest", link, open: false });
    }
  }

  /** End every team link. The games on either end of one see their connection drop. */
  private closeLinks(): void {
    if (this.linkTimer !== null) {
      clearTimeout(this.linkTimer);
      this.linkTimer = null;
    }
    const closed = new Set<RelayLink>();
    for (const seat of this.worlds.values()) {
      if (closed.has(seat.link)) continue;
      closed.add(seat.link);
      relayHub.close(seat.link);
    }
    this.worlds.clear();
  }

  /**
   * The host's world is up. Tell the teammate who has been waiting to join it.
   *
   * Remembered as well as relayed, because a guest who reconnects after this was said
   * has no other way to learn it.
   */
  teamWorldOpen(playerId: string): void {
    if (this.status !== "playing") return;
    const seat = this.worlds.get(playerId);
    if (!seat || seat.role !== "host") return;
    for (const [id, other] of this.worlds) {
      if (other.link !== seat.link) continue;
      other.open = true;
      if (other.role !== "guest") continue;
      const guest = this.players.get(id);
      if (guest) this.bus.send(guest.ws, { type: "team_world_ready" });
    }
  }

  /** What [viewer] is told about where they play. */
  private worldFor(viewer: PlayerSession): MatchWorld {
    const seat = this.worlds.get(viewer.id);
    if (!seat) return { role: "own", relayToken: null, mates: [] };
    const mates = [...this.players.values()]
      .filter((p) => p.id !== viewer.id && this.worlds.get(p.id)?.link === seat.link)
      .map((p) => ({ uuid: p.uuid, name: p.name }));
    return {
      role: seat.role,
      relayToken: seat.role === "host" ? seat.link.hostToken : seat.link.guestToken,
      mates,
    };
  }

  /** Whether two players are standing in the same world right now. */
  private sharesWorld(a: PlayerSession, b: PlayerSession): boolean {
    if (this.status !== "playing") return false;
    const link = this.worlds.get(a.id)?.link;
    return link !== undefined && link === this.worlds.get(b.id)?.link;
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
      // Everyone stalled, or somebody on each side: no one to award it to, so end it
      // with no winner. The second case only exists with teams — one player from each
      // still loading is a match neither side was ready for.
      const stalledSides = new Set(stalled.map((p) => p.side));
      if (stalled.length === this.players.size || stalledSides.size > 1) {
        console.warn(`[room ${this.code}] no world ready in time — ending with no winner`);
        this.endMatch(null, "disconnect", null);
        return;
      }
      const loser = stalled[0]!;
      console.warn(`[room ${this.code}] ${loser.name} never reported world_ready — forfeiting`);
      this.endByForfeit(loser.id, "disconnect");
      // A shared world is generated by one player and then joined by another, one after
      // the other, so it is allowed twice as long as a world somebody makes for themselves.
    }, this.config.readyTimeoutMs * (this.worlds.size > 0 ? 2 : 1));
    // Nothing should stay alive for this alone: it is a deadline on a match, and a
    // process with no sockets left has no match.
    this.readyTimer.unref();
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
    this.bus.toEveryone({ type: "countdown_start", startsAt, serverNow: Date.now() });
  }

  /**
   * Tell one socket when play opens, if that has been decided.
   *
   * `countdown_start` is broadcast exactly once, to whoever is connected at that instant.
   * A player who was mid-reconnect and a spectator who arrived later both missed it, and
   * for the player that was fatal: their client sat on the waiting screen for a countdown
   * that had already come and gone.
   */
  private sendCountdownIfArmed(ws: WebSocket): void {
    const startsAt = this.engine.playOpensAt;
    if (startsAt === null) return;
    this.bus.send(ws, { type: "countdown_start", startsAt, serverNow: Date.now() });
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
    this.forfeitVotes.clear();
    const eloChanges = this.matchSettled ? {} : this.settle(winnerSide, reason, quitter);
    this.matchSettled = true;
    this.status = "ended";
    this.endedAt = Date.now();
    this.bus.toEveryone({ type: "match_end", winner: winnerSide, reason, eloChanges });

    // Not closed here. The result stays on screen for some seconds with everybody still
    // standing in their world, and cutting the link now would throw the guest out of it
    // onto a "connection lost" screen over the top of the result. A rematch closes them
    // at once; this is for the room that never plays again.
    if (this.worlds.size > 0 && this.linkTimer === null) {
      this.linkTimer = setTimeout(() => {
        this.linkTimer = null;
        this.closeLinks();
      }, LINK_LINGER_MS);
      this.linkTimer.unref();
    }

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
    const sideOf = (side: Side) =>
      all.filter((s) => s.side === side).sort((x, y) => x.seatedAt - y.seatedAt);
    const as = sideOf("A");
    const bs = sideOf("B");
    const names = (team: PlayerSession[]) => team.map((s) => s.name).join(", ") || null;
    return settleMatch({
      roomCode: this.code,
      seed: this.engine.seed,
      startedAt: this.engine.startedAt,
      board: this.engine.board ?? [],
      claimedLog: this.engine.claimedLog,
      settings: this.settings,
      origin: this.origin,
      playOpened: this.engine.isArmed,
      a: as[0] ?? null,
      b: bs[0] ?? null,
      teamNames: as.length > 1 || bs.length > 1 ? { A: names(as), B: names(bs) } : undefined,
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
    if (this.status === "playing") {
      this.sendCountdownIfArmed(session.ws);
      const seat = this.worlds.get(playerId);
      if (seat?.role === "guest" && seat.open) this.bus.send(session.ws, { type: "team_world_ready" });
      // A request made while this player was away is still standing, and they are the
      // one it is waiting on.
      if (session.side && this.forfeitVotes.size > 0) this.sendForfeitVotes(session.side);
    }
  }

  /**
   * Relay a chat line to everyone who has not already seen it.
   *
   * The sender's own game showed it as they typed. So did their teammate's, when the two
   * are in one world: the game delivers chat to everybody standing in it, and sending it
   * round again through here would print every line twice.
   */
  broadcastChat(playerId: string, text: string): void {
    const sender = this.players.get(playerId);
    if (!sender) return;
    this.bus.toSpectatorsAnd((p) => p.id !== playerId && !this.sharesWorld(sender, p), {
      type: "chat_message", senderId: playerId, senderName: sender.name, text,
    });
  }

  broadcastWorldEvent(playerId: string, kind: "death" | "advancement" | "forfeit", text: string): void {
    const sender = this.players.get(playerId);
    if (!sender) return;
    // Deaths and advancements are announced by the game to everyone in the world, like
    // chat. Giving up is ours — the game has no idea a match exists — so the teammate
    // hears about it from here or not at all.
    const seenInWorld = kind !== "forfeit";
    this.bus.toSpectatorsAnd(
      (p) => p.id !== playerId && !(seenInWorld && this.sharesWorld(sender, p)),
      { type: "world_event_message", senderId: playerId, senderName: sender.name, kind, text },
    );
  }

  private sendRoomState(ws: WebSocket, viewer: PlayerSession | null): void {
    const sessions = [...this.membersOf("A"), ...this.membersOf("B")];
    // Spectators have no seat, so they get the first seat as "you". `opponent` is the
    // first player on the other side from that — never a teammate, because a client
    // that only knows these two fields reads "no opponent" as "this is a solo run", and
    // for a player whose only company is a teammate that is the right answer.
    const you = viewer ?? sessions[0] ?? null;
    const opp = you ? sessions.find((s) => s.side !== you.side) ?? null : null;
    const players: RoomPlayer[] = sessions.map((s) => ({
      ...toPlayerInfo(s),
      worldOwner: s.side !== null && this.membersOf(s.side)[0]?.id === s.id,
    }));

    this.bus.send(ws, {
      type: "room_state",
      roomCode: this.code,
      status: this.status,
      origin: this.origin,
      you: you ? toPlayerInfo(you) : null,
      opponent: opp ? toPlayerInfo(opp) : null,
      players,
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
      solo: this.solo,
      world: viewer ? this.worldFor(viewer) : null,
      seedFeatures: this.poolSeed ? [...this.poolSeed.features] : null,
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

/** One player's place in a shared team world. See [Room.worlds]. */
interface TeamWorldSeat {
  readonly role: "host" | "guest";
  readonly link: RelayLink;
  /** Whether the host has said the world is up and joinable. */
  open: boolean;
}

/**
 * How long a finished match's team links outlive it.
 *
 * Comfortably past the mod's result screen, after which every client has left its world
 * by itself. Only a room that never plays again waits this out.
 */
const LINK_LINGER_MS = 60_000;

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
