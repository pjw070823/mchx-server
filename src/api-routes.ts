import type express from "express";
import { ALL_MISSIONS } from "./missions.js";
import type { RoomRegistry } from "./room.js";
import {
  getAllMatches,
  getLeaderboard,
  getMatchById,
  getMatchCount,
  getMatchesByPlayerName,
  getPlayer,
  getRecentMatches,
  searchPlayersByName,
} from "./db.js";

/** Shape of a Minecraft account id, enforced before anything reaches the database. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Every read-only REST route the web UI needs.
 *
 * Mounted on BOTH listeners — the mod-facing API port and the spectator port — so the
 * static page can call `/api/*` same-origin no matter which one served it.
 *
 * All queries here are synchronous (`node:sqlite`), so a slow one blocks the event loop
 * for everyone. That is why every input is length-capped and every limit is clamped
 * rather than passed through.
 */
export function mountApiRoutes(target: express.Express, rooms: RoomRegistry): void {
  target.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  target.get("/api/missions", (_req, res) => {
    res.json({ version: 1, missions: ALL_MISSIONS });
  });

  target.get("/api/rating/:uuid", (req, res) => {
    if (!UUID_RE.test(req.params.uuid)) return res.status(400).json({ error: "bad_uuid" });
    const row = getPlayer(req.params.uuid);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  });

  target.get("/api/leaderboard", (req, res) => {
    res.json({ players: getLeaderboard(clampInt(req.query.limit, 50, 1, 200)) });
  });

  target.get("/api/matches", (req, res) => {
    const uuid = req.query.uuid ? String(req.query.uuid) : null;
    const player = req.query.player ? String(req.query.player) : null;
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);

    if (uuid) {
      if (!UUID_RE.test(uuid)) return res.status(400).json({ error: "bad_uuid" });
      return res.json({ matches: getRecentMatches(uuid, limit), total: undefined });
    }
    if (player) {
      return res.json({
        matches: getMatchesByPlayerName(player, limit, offset),
        total: getMatchCount(player),
      });
    }
    return res.json({ matches: getAllMatches(limit, offset), total: getMatchCount() });
  });

  target.get("/api/matches/:id", (req, res) => {
    const id = matchId(req.params.id);
    if (id === null) return res.status(400).json({ error: "bad_id" });
    const row = getMatchById(id);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  });

  /**
   * Slim listing for the replay archive.
   *
   * `/api/matches` returns whole rows, board and claim log included — roughly 2KB of JSON
   * per match that a list never reads. This returns the same shape the live listing uses
   * so both can be rendered by one row component.
   */
  target.get("/api/replays", (req, res) => {
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);

    const replays = getAllMatches(limit, offset)
      .map((row) => {
        const claims = parseJsonArray(row.claimed_json);
        let claimedA = 0;
        let claimedB = 0;
        for (const c of claims) {
          if (c?.side === "A") claimedA++;
          else if (c?.side === "B") claimedB++;
        }
        return {
          id: row.id,
          roomCode: row.room_code,
          rated: row.rated === 1,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          winnerSide: row.winner_side,
          reason: row.reason,
          claimedA,
          claimedB,
          boardSize: parseJsonArray(row.board_json).length,
          players: {
            A: { name: row.player_a_name, elo: row.player_a_elo_after ?? row.player_a_elo_before },
            B: { name: row.player_b_name, elo: row.player_b_elo_after ?? row.player_b_elo_before },
          },
        };
      })
      // A match with no board was never dealt, so there is nothing to open.
      .filter((r) => r.boardSize > 0);

    res.json({ replays, total: getMatchCount() });
  });

  /**
   * Everything the replay page needs, already parsed and ordered.
   *
   * The raw row on `/api/matches/:id` carries the board and claim log as JSON strings
   * plus the seed. Replay needs neither the strings nor the seed, and parsing per-claim
   * in the browser would have every caller re-implement the ordering.
   */
  target.get("/api/matches/:id/replay", (req, res) => {
    const id = matchId(req.params.id);
    if (id === null) return res.status(400).json({ error: "bad_id" });

    const row = getMatchById(id);
    if (!row) return res.status(404).json({ error: "not_found" });

    const board = parseJsonArray(row.board_json);
    const claims = parseJsonArray(row.claimed_json);
    // A match that ended before anyone claimed anything has nothing to play back.
    if (board.length === 0) return res.status(404).json({ error: "no_replay" });

    res.json({
      id: row.id,
      roomCode: row.room_code,
      rated: row.rated === 1,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      winnerSide: row.winner_side,
      reason: row.reason,
      settings: parseJsonObject(row.settings_json),
      players: {
        A: {
          name: row.player_a_name, uuid: row.player_a_uuid,
          eloBefore: row.player_a_elo_before, eloAfter: row.player_a_elo_after,
        },
        B: {
          name: row.player_b_name, uuid: row.player_b_uuid,
          eloBefore: row.player_b_elo_before, eloAfter: row.player_b_elo_after,
        },
      },
      board,
      // Stored in claim order already, but the page scrubs by index — an out-of-order
      // row would silently rewind the board mid-playback.
      claims: claims.slice().sort((x, y) => (x.claimedAt ?? 0) - (y.claimedAt ?? 0)),
    });
  });

  target.get("/api/players/search", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ players: [] });
    // Cap the term so a 100KB `?q=` can't tie up the synchronous query.
    if (q.length > 64) return res.status(400).json({ error: "query_too_long" });
    res.json({ players: searchPlayersByName(q, clampInt(req.query.limit, 50, 1, 100)) });
  });

  target.get("/api/players/:uuid", (req, res) => {
    if (!UUID_RE.test(req.params.uuid)) return res.status(400).json({ error: "bad_uuid" });
    const row = getPlayer(req.params.uuid);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  });

  target.get("/api/rooms", (_req, res) => {
    res.json({ rooms: rooms.listActive() });
  });
}

/** Coerce a query param to an integer inside [lo, hi], falling back when unparseable. */
export function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/**
 * A row id, or null if the input isn't one.
 *
 * Digits only. `Number()` is far too generous for a URL segment — it reads "1e3" as 1000
 * and "0x10" as 16, so an id check built on `Number.isInteger` alone quietly resolves
 * those to real rows. The id space is the AUTOINCREMENT one, so 0 and up are a miss by
 * definition, and anything past MAX_SAFE_INTEGER can no longer round-trip.
 */
const MATCH_ID_RE = /^\d{1,16}$/;

function matchId(raw: string): number | null {
  if (!MATCH_ID_RE.test(raw)) return null;
  const n = Number(raw);
  if (n < 1 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

/** These columns are written by us, but a truncated write shouldn't take the route down. */
function parseJsonArray(raw: string | null): any[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export { UUID_RE, matchId, parseJsonArray, parseJsonObject };
