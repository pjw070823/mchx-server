import type { WebSocket } from "ws";
import type { ConnState } from "./conn-state.js";
import type { Room, RoomRegistry } from "./room.js";
import type { RoomConfig } from "./room-config.js";
import { DEFAULT_ELO, getOrCreatePlayer } from "./db.js";
import { send, sendError } from "./wire.js";

/**
 * The ranked queue.
 *
 * Holds verified accounts waiting for an opponent, pairs them on a timer by rating, and
 * builds the room itself. There is no accept prompt — a pairing goes straight into a
 * match, which is why nothing here may pair a connection it isn't sure is alive.
 *
 * Policy lives entirely in [Matchmaker.enqueue]. `handlers.ts` only forwards the request
 * and reports the refusal, so there is no second place where the rules could drift.
 */

export const QUEUE_TUNING = {
  /** How often pairing runs. */
  tickMs: 1_000,
  /** How often a still-waiting player is told what the queue is doing. */
  pushIntervalMs: 5_000,
  /**
   * Starting ELO half-width. At this scale (elo.ts uses SCALE 400) a 100-point gap is a
   * 64% expected score — clearly winnable, which is the honest definition of "fair".
   */
  initialWindow: 100,
  /** ±300 at 10s, ±400 (a 91% favourite) at 15s, capped at ~95s. */
  widenPerSecond: 20,
  /** Ratings start at 500 and move by tens, so this is "no constraint" without Infinity. */
  maxWindow: 2_000,
  /**
   * After this long, a waiter is paired with the next arrival regardless of rating.
   *
   * Without it, using the *stricter* of two windows (see [canPair]) strands exactly the
   * person we most want to serve: someone alone for five minutes has a huge window, but
   * a fresh arrival 800 points away has a small one, so they never meet.
   */
  openToAnyoneAfterMs: 120_000,
} as const;

/**
 * Relaxes the two rules that make local testing impossible: verification and the
 * same-IP refusal. Two clients on one machine share an address, and dev bots have no
 * Mojang account — between them, the queue would refuse every pairing you could
 * actually stage.
 *
 * One switch with one meaning: this server's queue is in dev mode and its ratings are
 * meaningless. That second part enforces itself — an unverified player has no uuid, and
 * `settlement.ts` force-unrates any match missing one.
 */
const DEV_MODE_DEFAULT = process.env.MCHX_DEV_QUEUE === "1";

export type QueueLeaveReason = "cancelled" | "matched" | "disconnected" | "closed";

export type EnqueueFailure =
  | "not_verified"
  | "already_queued"
  | "already_in_room"
  | "uuid_in_use"
  | "queue_cooldown";

export type EnqueueResult = { ok: true } | { ok: false; code: EnqueueFailure };

/** Player-facing text for each refusal. The mod maps the codes to its own Korean. */
export const QUEUE_ERROR_TEXT: Record<EnqueueFailure, string> = {
  not_verified: "ranked play requires a verified Minecraft account",
  already_queued: "already in the queue",
  already_in_room: "leave your room first",
  uuid_in_use: "this account is already queued or in a room",
  queue_cooldown: "slow down",
};

interface QueueEntry {
  /**
   * The connection itself, so a pairing can seat the player directly.
   *
   * `handlers.ts` already assigns `state.room` from five places; the matchmaker is doing
   * the same job as `joinRoom` and uses the same mechanism. The alternative — emitting a
   * "matched" event for `index.ts` to act on — would split one atomic operation in two
   * and open a window where a ranked room exists with `conn.room` still unset, during
   * which a `create_room` from either player would succeed.
   *
   * The cost: an entry holds a socket strongly, so a leaked entry leaks a socket. That
   * is why `handleClose` must dequeue and why [tick] sweeps closed sockets anyway.
   */
  readonly conn: ConnState;
  readonly ws: WebSocket;
  readonly uuid: string | null;
  readonly name: string;
  readonly remoteAddr: string | null;
  /**
   * Rating as of entry. Never re-read while queued — [tick] must not touch the database,
   * because `node:sqlite` is synchronous and every query blocks the event loop.
   *
   * It cannot go stale: mutual exclusion means a queued account is not in a room, so
   * nothing can move its rating while it waits.
   */
  readonly elo: number;
  readonly gamesPlayed: number;
  readonly enqueuedAt: number;
  /** When this entry was last sent a `queue_state`. */
  lastPushAt: number;
}

export interface MatchmakerDeps {
  readonly rooms: RoomRegistry;
  /** Injected so tests can collapse the room's timing gates. */
  readonly roomConfig?: Partial<RoomConfig>;
  /** Injected clock, so widening can be tested without waiting or faking timers. */
  readonly now?: () => number;
  /** Overrides MCHX_DEV_QUEUE. Only tests pass this. */
  readonly devMode?: boolean;
}

export interface MatchedPair {
  readonly room: Room;
  readonly aId: string;
  readonly bId: string;
  readonly gap: number;
}

/** ELO half-width this entry will accept after waiting `waitedMs`. Pure. */
export function eloWindow(waitedMs: number): number {
  const widened =
    QUEUE_TUNING.initialWindow + (Math.max(0, waitedMs) / 1000) * QUEUE_TUNING.widenPerSecond;
  return Math.min(QUEUE_TUNING.maxWindow, Math.floor(widened));
}

export class Matchmaker {
  private readonly rooms: RoomRegistry;
  private readonly roomConfig: Partial<RoomConfig>;
  private readonly now: () => number;
  private readonly devMode: boolean;

  /** Insertion-ordered. Small enough that an O(n²) pairing scan is the right call. */
  private readonly entries: QueueEntry[] = [];
  private readonly byUuid = new Map<string, QueueEntry>();
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: MatchmakerDeps) {
    this.rooms = deps.rooms;
    this.roomConfig = deps.roomConfig ?? {};
    this.now = deps.now ?? Date.now;
    this.devMode = deps.devMode ?? DEV_MODE_DEFAULT;
    if (this.devMode) {
      console.warn("[mm] MCHX_DEV_QUEUE=1 — queue accepts guests and same-IP pairs.");
      console.warn("[mm] Ratings from this server are meaningless. Never set this in production.");
    }
  }

  size(): number {
    return this.entries.length;
  }

  isQueued(state: ConnState): boolean {
    return this.entries.some((e) => e.conn === state);
  }

  hasUuid(uuid: string): boolean {
    return this.byUuid.has(uuid);
  }

  /**
   * Take a slot in the queue, or say why not.
   *
   * Ranked means rated, and `settlement.ts` force-unrates any match with an
   * unauthenticated player — so letting a guest queue would produce a "ranked" match
   * that moves nobody's rating. Refusing up front is the honest version.
   *
   * The socket is passed in rather than read off `state`: `index.ts` keys sockets to
   * connections, not the reverse, and every caller already has both in hand.
   */
  enqueue(state: ConnState, ws: WebSocket): EnqueueResult {
    const now = this.now();

    if (!state.verified && !this.devMode) return { ok: false, code: "not_verified" };
    if (state.room) return { ok: false, code: "already_in_room" };
    if (this.isQueued(state)) return { ok: false, code: "already_queued" };
    if (now < state.queueCooldownUntil) return { ok: false, code: "queue_cooldown" };

    const uuid = state.verified?.uuid ?? null;
    const name = state.verified?.name ?? `guest-${state.playerId.slice(0, 6)}`;
    if (uuid && (this.byUuid.has(uuid) || this.rooms.findRoomContainingUuid(uuid))) {
      // Same account on a second socket, queued or already playing.
      return { ok: false, code: "uuid_in_use" };
    }

    // The one client-controlled database read in the whole queue. Guarded by the
    // cooldown, which is why the cooldown exists at all.
    let elo = DEFAULT_ELO;
    let gamesPlayed = 0;
    if (uuid) {
      try {
        const record = getOrCreatePlayer(uuid, name);
        elo = record.elo;
        gamesPlayed = record.games_played;
      } catch (e) {
        console.warn(`[mm] getOrCreatePlayer failed: ${(e as Error).message}`);
      }
    }

    const entry: QueueEntry = {
      conn: state,
      ws,
      uuid,
      name,
      remoteAddr: state.remoteAddr,
      elo,
      gamesPlayed,
      enqueuedAt: now,
      lastPushAt: now,
    };
    this.entries.push(entry);
    if (uuid) this.byUuid.set(uuid, entry);

    console.log(`[mm] queued ${name} (${elo}) — ${this.entries.length} waiting`);
    this.push(entry, true, null, now);
    return { ok: true };
  }

  /** Idempotent. True if a slot was actually released. */
  dequeue(state: ConnState, reason: QueueLeaveReason): boolean {
    const index = this.entries.findIndex((e) => e.conn === state);
    if (index === -1) return false;

    const [entry] = this.entries.splice(index, 1);
    if (entry!.uuid) this.byUuid.delete(entry!.uuid);

    const now = this.now();
    // Rate-limit re-entry: each enqueue costs a synchronous DB read.
    state.queueCooldownUntil = now + 1_000;

    console.log(`[mm] dequeued ${entry!.name} (${reason}) — ${this.entries.length} waiting`);
    // A disconnected socket has nothing to tell.
    if (reason !== "disconnected") this.push(entry!, false, reason, now);
    return true;
  }

  start(intervalMs: number = QUEUE_TUNING.tickMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pairing pass.
   *
   * Longest waiter first, then the eligible opponent with the smallest rating gap.
   * Greedy rather than globally optimal — a stable-matching pass would buy nothing at
   * this scale and would be much harder to explain when someone asks why they were
   * paired with whom.
   */
  tick(): { matched: MatchedPair[] } {
    const now = this.now();
    this.sweepClosed();

    const pending = [...this.entries].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    const taken = new Set<QueueEntry>();
    const matched: MatchedPair[] = [];

    for (const a of pending) {
      if (taken.has(a)) continue;

      let best: QueueEntry | null = null;
      let bestGap = Infinity;
      for (const b of pending) {
        if (b === a || taken.has(b)) continue;
        if (!this.canPair(a, b, now)) continue;
        const gap = Math.abs(a.elo - b.elo);
        if (gap < bestGap) { best = b; bestGap = gap; }
      }
      if (!best) continue;

      taken.add(a);
      taken.add(best);
      const pair = this.createRankedMatch(a, best, bestGap, now);
      if (pair) matched.push(pair);
    }

    this.pushWaiting(now);
    return { matched };
  }

  // --- internals -------------------------------------------------------------------

  private canPair(a: QueueEntry, b: QueueEntry, now: number): boolean {
    // Belt: the uuid index already blocks one account holding two slots.
    if (a.uuid && b.uuid && a.uuid === b.uuid) return false;

    // Two players behind one address are never paired. `settlement.ts` would catch it
    // after the fact by force-unrating, which is the worst outcome — they would play a
    // ranked match and get nothing for it. Known cost: flatmates cannot queue together.
    // No diagnostic is sent, deliberately: "your only opponent shares your IP" lets you
    // probe who is behind your NAT by timing.
    if (!this.devMode && a.remoteAddr && b.remoteAddr && a.remoteAddr === b.remoteAddr) return false;

    if (this.openToAnyone(a, now) || this.openToAnyone(b, now)) return true;

    const gap = Math.abs(a.elo - b.elo);
    // The stricter of the two, so someone who just arrived is not dragged into a
    // mismatch by a long waiter's widened window.
    return gap <= Math.min(eloWindow(now - a.enqueuedAt), eloWindow(now - b.enqueuedAt));
  }

  private openToAnyone(entry: QueueEntry, now: number): boolean {
    return now - entry.enqueuedAt >= QUEUE_TUNING.openToAnyoneAfterMs;
  }

  /** Drop entries whose socket already went away. `handleClose` is the primary path. */
  private sweepClosed(): void {
    for (const entry of [...this.entries]) {
      if (entry.ws.readyState === entry.ws.OPEN) continue;
      this.dequeue(entry.conn, "disconnected");
    }
  }

  /**
   * Build the room and start the match.
   *
   * The order below is load-bearing. `room_state` MUST reach the clients before
   * `match_start`: the mod reads `MatchState.roomCode` when handling `match_start`, and
   * that field only ever arrives via `room_state`. Reversed, the client logs "cannot
   * create world" and hangs on a black screen. The custom-room path happens to produce
   * this order already, which is why nothing catches it today.
   */
  private createRankedMatch(a: QueueEntry, b: QueueEntry, gap: number, now: number): MatchedPair | null {
    // Remove first: nothing re-entrant can double-book a seat that is already gone.
    this.dequeue(a.conn, "matched");
    this.dequeue(b.conn, "matched");

    const room = this.rooms.create(this.roomConfig, "ranked");
    const seatA = room.addPlayer(a.conn.playerId, a.name, a.uuid, a.ws, a.remoteAddr);
    const seatB = room.addPlayer(b.conn.playerId, b.name, b.uuid, b.ws, b.remoteAddr);

    if (!seatA || !seatB) {
      // Cannot happen on a room built one line ago. If it ever does, something is badly
      // wrong and a silent re-queue would hide it.
      console.error(`[mm] could not seat a fresh ranked room ${room.code}`);
      this.rooms.delete(room.code);
      for (const e of [a, b]) sendError(e.ws, "queue_failed", "could not start a ranked match");
      return null;
    }

    a.conn.room = room;
    b.conn.room = room;
    a.conn.isSpectator = false;
    b.conn.isSpectator = false;

    room.notifyJoin();
    const started = room.start();
    if (!started.ok) {
      console.error(`[mm] ranked room ${room.code} refused to start: ${started.reason}`);
      return null;
    }

    console.log(
      `[mm] matched ${a.name}(${a.elo}) vs ${b.name}(${b.elo}) gap=${gap} ` +
        `waited=${((now - a.enqueuedAt) / 1000).toFixed(1)}s/${((now - b.enqueuedAt) / 1000).toFixed(1)}s ` +
        `-> ${room.code}`,
    );
    return { room, aId: a.conn.playerId, bId: b.conn.playerId, gap };
  }

  private pushWaiting(now: number): void {
    for (const entry of this.entries) {
      if (now - entry.lastPushAt < QUEUE_TUNING.pushIntervalMs) continue;
      this.push(entry, true, null, now);
    }
  }

  private push(entry: QueueEntry, queued: boolean, reason: QueueLeaveReason | null, now: number): void {
    entry.lastPushAt = now;
    const waitingMs = queued ? now - entry.enqueuedAt : 0;
    send(entry.ws, {
      type: "queue_state",
      queued,
      reason,
      waitingMs,
      size: this.entries.length,
      elo: entry.elo,
      window: queued ? eloWindow(waitingMs) : 0,
    });
  }
}
