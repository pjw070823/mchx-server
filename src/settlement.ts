import type { BoardTile, ClaimedTile, EloChange, RoomSettings, Side } from "./protocol.js";
import { applyMatchResult, inTransaction, recordMatch } from "./db.js";
import { computeNewElo } from "./elo.js";
import type { PlayerSession } from "./session.js";

export interface SettlementInput {
  readonly roomCode: string;
  readonly seed: bigint;
  readonly startedAt: number | null;
  readonly board: readonly BoardTile[];
  readonly claimedLog: readonly ClaimedTile[];
  readonly settings: RoomSettings;
  /** Side A's session, even if they have already been removed from the room. */
  readonly a: PlayerSession | null;
  readonly b: PlayerSession | null;
  readonly winnerSide: Side | null;
  readonly reason: "connection" | "forfeit" | "disconnect";
}

/**
 * Close the books on a finished match: work out the rating change, write it and the
 * match record in one transaction, and hand back the per-player deltas to show.
 *
 * Split out of Room because none of it is about running a room — it is bookkeeping that
 * happens once at the end, and it is the part with the most rules packed into the least
 * code (rating maths, the self-play guard, transactional persistence).
 */
export function settleMatch(input: SettlementInput): Record<string, EloChange> {
  const { a, b, winnerSide, reason } = input;

  const aScore: 0 | 0.5 | 1 = winnerSide === "A" ? 1 : winnerSide === "B" ? 0 : 0.5;
  const bScore: 0 | 0.5 | 1 = winnerSide === "B" ? 1 : winnerSide === "A" ? 0 : 0.5;

  const { rated, unratedReason } = resolveRated(input);
  if (unratedReason) {
    console.warn(`[room ${input.roomCode}] match force-unrated: ${unratedReason}`);
  }

  const eloChanges: Record<string, EloChange> = {};
  let aBefore: number | null = null, aAfter: number | null = null;
  let bBefore: number | null = null, bAfter: number | null = null;

  if (rated && a && b) {
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

  // One transaction for both ratings and the audit row: a failure part-way through
  // must not leave one player's rating moved with no record of why.
  try {
    inTransaction(() => {
      if (rated && a && b) {
        if (a.uuid) applyMatchResult(a.uuid, aAfter!, outcomeOf(aScore));
        if (b.uuid) applyMatchResult(b.uuid, bAfter!, outcomeOf(bScore));
      }
      recordMatch({
        roomCode: input.roomCode,
        seed: input.seed.toString(),
        startedAt: input.startedAt,
        endedAt: Date.now(),
        winnerSide: winnerSide ?? null,
        reason,
        settingsJson: JSON.stringify(input.settings),
        boardJson: JSON.stringify(input.board),
        claimedJson: JSON.stringify(input.claimedLog),
        playerAUuid: a?.uuid ?? null,
        playerAName: a?.name ?? null,
        playerAEloBefore: aBefore,
        playerAEloAfter: aAfter,
        playerBUuid: b?.uuid ?? null,
        playerBName: b?.name ?? null,
        playerBEloBefore: bBefore,
        playerBEloAfter: bAfter,
        rated,
      });
    });
    // Reflect the new rating into the live sessions only after the commit, so clients
    // never see a rating the database doesn't have.
    if (rated && a && b) {
      a.elo = aAfter!;
      b.elo = bAfter!;
    }
  } catch (e) {
    console.warn(`[room ${input.roomCode}] settle DB tx failed: ${(e as Error).message}`);
  }

  return eloChanges;
}

/**
 * Decide whether this match may move ratings.
 *
 * Three ways to lose that right:
 *
 *  - **Unauthenticated.** A session only carries a uuid if Mojang confirmed the account,
 *    so a null uuid means we do not know who this was. Rating an anonymous player would
 *    put the ladder back where it started: anyone able to claim any identity.
 *  - **Same account on both sides.** The cheapest possible farm.
 *  - **Same machine.** Catches the two-clients-one-PC version of the same thing. Genuine
 *    siblings on one connection get caught too; they can still play, just not for rating.
 */
function resolveRated(input: SettlementInput): { rated: boolean; unratedReason: string | null } {
  const { a, b, settings } = input;
  if (!settings.rated || !a || !b) return { rated: settings.rated, unratedReason: null };
  if (!a.uuid || !b.uuid) return { rated: false, unratedReason: "unauthenticated" };
  if (a.uuid === b.uuid) return { rated: false, unratedReason: "same_uuid" };
  if (a.remoteAddr && b.remoteAddr && a.remoteAddr === b.remoteAddr) {
    return { rated: false, unratedReason: "same_ip" };
  }
  return { rated: true, unratedReason: null };
}

function outcomeOf(score: 0 | 0.5 | 1): 1 | -1 | 0 {
  return score === 1 ? 1 : score === 0 ? -1 : 0;
}
