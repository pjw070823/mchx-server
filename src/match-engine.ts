import { randomBytes } from "node:crypto";
import type { BoardTile, ClaimedTile, Side, TileId } from "./protocol.js";
import { buildBoard, hasWon, mulberry32 } from "./hex.js";
import { getMission } from "./missions.js";
import type { PlayerSession } from "./session.js";
import type { RoomConfig } from "./room-config.js";

/** Why a claim was turned away. Sent to the client verbatim as `claim_rejected.reason`. */
export type ClaimRejection =
  | "match_not_active"
  | "countdown"
  | "too_fast"
  | "unknown_tile"
  | "wrong_mission"
  | "unknown_mission"
  | "already_claimed";

export type ClaimOutcome =
  | { readonly ok: false; readonly reason: ClaimRejection }
  | { readonly ok: true; readonly claim: ClaimedTile; readonly winningSide: Side | null };

/**
 * The rules of a match: the board, who owns which tile, and whether a claim is legal.
 *
 * Extracted from Room because these are the only parts that would need re-reading to
 * answer "can this tile be taken right now?" — everything else Room does (seats,
 * settings, sockets, ratings) is irrelevant to that question. Nothing here touches a
 * socket or the database; the engine decides, and Room reacts.
 */
export class MatchEngine {
  /** Re-rolled per match so a rematch generates a different world. */
  seed: bigint = randomSeed64();
  board: BoardTile[] | null = null;
  startedAt: number | null = null;

  readonly claimedMap = new Map<TileId, Side>();
  readonly claimedLog: ClaimedTile[] = [];

  private readonly readyPlayers = new Set<string>();
  /** When play actually opens, i.e. the end of the countdown. Null until armed. */
  private activeAt: number | null = null;

  constructor(private readonly config: RoomConfig) {}

  /**
   * Start a fresh match. The seed is re-rolled every time: reusing it would make both
   * clients regenerate the *same* world directory on disk and collide with the previous
   * match's terrain.
   */
  begin(): void {
    this.seed = randomSeed64();
    this.board = buildBoard(mulberry32(Number(this.seed & 0xffffffffn)));
    this.claimedMap.clear();
    this.claimedLog.length = 0;
    this.startedAt = Date.now();
    this.readyPlayers.clear();
    this.activeAt = null;
  }

  /** True once the countdown has been armed — claims are gated on this. */
  get isArmed(): boolean {
    return this.activeAt !== null;
  }

  /**
   * Record that a player's world has finished loading. Once everyone has reported in,
   * arm the countdown and return the instant play begins; null while still waiting.
   */
  markReady(playerId: string, requiredCount: number): number | null {
    if (!this.board || this.activeAt !== null) return null;
    this.readyPlayers.add(playerId);
    if (this.readyPlayers.size < requiredCount) return null;
    this.activeAt = Date.now() + this.config.countdownMs;
    return this.activeAt;
  }

  /**
   * Decide a claim. On success the tile is recorded and `winningSide` says whether that
   * claim completed a winning chain.
   *
   * The two time gates exist to defeat the cheapest cheat client — one that fires all 25
   * claims the instant the match starts. Neither threshold is reachable by real play.
   */
  attemptClaim(player: PlayerSession, tileId: TileId, missionId: string): ClaimOutcome {
    if (!this.board) return { ok: false, reason: "match_not_active" };

    const now = Date.now();
    if (this.activeAt === null || now < this.activeAt) return { ok: false, reason: "countdown" };
    if (now - this.activeAt < this.config.minTimeToFirstClaimMs) return { ok: false, reason: "too_fast" };
    if (player.lastClaimAt !== null && now - player.lastClaimAt < this.config.minIntervalBetweenClaimsMs) {
      return { ok: false, reason: "too_fast" };
    }

    const tile = this.board.find((t) => t.tileId === tileId);
    if (!tile) return { ok: false, reason: "unknown_tile" };
    if (tile.missionId !== missionId) return { ok: false, reason: "wrong_mission" };
    if (!getMission(missionId)) return { ok: false, reason: "unknown_mission" };
    if (this.claimedMap.has(tileId)) return { ok: false, reason: "already_claimed" };

    const side = player.side!;
    const claim: ClaimedTile = { tileId, side, missionId, claimedAt: now };
    player.lastClaimAt = now;
    this.claimedMap.set(tileId, side);
    this.claimedLog.push(claim);

    return { ok: true, claim, winningSide: hasWon(side, this.claimedMap) ? side : null };
  }
}

/**
 * Cryptographically random match seed. `Math.random` is predictable from a handful of
 * samples, and a predictable seed lets an opponent pre-compute the whole board — and
 * with it the fastest mission order — before the match starts.
 */
function randomSeed64(): bigint {
  return randomBytes(8).readBigInt64BE(0);
}
