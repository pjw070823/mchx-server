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
    const id = Number(req.params.id);
    // A positive integer, matching the AUTOINCREMENT id space. `isFinite` would let
    // floats and scientific notation through.
    if (!Number.isInteger(id) || id < 1 || id > Number.MAX_SAFE_INTEGER) {
      return res.status(400).json({ error: "bad_id" });
    }
    const row = getMatchById(id);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
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

export { UUID_RE };
