// Uses Node's built-in SQLite (experimental in Node 22, stable in 23+).
// No native compile required — works on Linux/Windows alike via Node binary.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_ELO = 500;

const DB_PATH = resolve(process.env.MCHX_DB_PATH ?? "./data/mchx.sqlite");

mkdirSync(dirname(DB_PATH), { recursive: true });

const db: DatabaseSync = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS players (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    elo INTEGER NOT NULL DEFAULT ${DEFAULT_ELO},
    games_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT,
    seed TEXT,
    started_at INTEGER,
    ended_at INTEGER NOT NULL,
    winner_side TEXT,
    reason TEXT,
    settings_json TEXT,
    board_json TEXT,
    claimed_json TEXT,
    player_a_uuid TEXT,
    player_a_name TEXT,
    player_a_elo_before INTEGER,
    player_a_elo_after INTEGER,
    player_b_uuid TEXT,
    player_b_name TEXT,
    player_b_elo_before INTEGER,
    player_b_elo_after INTEGER,
    rated INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_matches_player_a ON matches(player_a_uuid);
  CREATE INDEX IF NOT EXISTS idx_matches_player_b ON matches(player_b_uuid);
  CREATE INDEX IF NOT EXISTS idx_matches_ended_at ON matches(ended_at DESC);
  CREATE INDEX IF NOT EXISTS idx_players_elo ON players(elo DESC);
`);

export interface PlayerRow {
  uuid: string;
  name: string;
  elo: number;
  games_played: number;
  wins: number;
  losses: number;
  draws: number;
  updated_at: number;
}

export interface MatchRow {
  id: number;
  room_code: string | null;
  seed: string | null;
  started_at: number | null;
  ended_at: number;
  winner_side: string | null;
  reason: string | null;
  settings_json: string | null;
  board_json: string | null;
  claimed_json: string | null;
  player_a_uuid: string | null;
  player_a_name: string | null;
  player_a_elo_before: number | null;
  player_a_elo_after: number | null;
  player_b_uuid: string | null;
  player_b_name: string | null;
  player_b_elo_before: number | null;
  player_b_elo_after: number | null;
  rated: number; // 0/1
}

const getPlayerStmt: StatementSync = db.prepare("SELECT * FROM players WHERE uuid = ?");
const insertPlayerStmt: StatementSync = db.prepare(
  `INSERT INTO players (uuid, name, elo, games_played, wins, losses, draws, updated_at)
   VALUES (?, ?, ?, 0, 0, 0, 0, ?)`,
);
const updatePlayerNameStmt: StatementSync = db.prepare(
  `UPDATE players SET name = ?, updated_at = ? WHERE uuid = ?`,
);
const applyMatchResultStmt: StatementSync = db.prepare(
  `UPDATE players SET
     elo = ?,
     games_played = games_played + 1,
     wins = wins + ?,
     losses = losses + ?,
     draws = draws + ?,
     updated_at = ?
   WHERE uuid = ?`,
);
const leaderboardStmt: StatementSync = db.prepare(
  `SELECT * FROM players ORDER BY elo DESC, games_played DESC LIMIT ?`,
);
const insertMatchStmt: StatementSync = db.prepare(
  `INSERT INTO matches (
     room_code, seed, started_at, ended_at, winner_side, reason,
     settings_json, board_json, claimed_json,
     player_a_uuid, player_a_name, player_a_elo_before, player_a_elo_after,
     player_b_uuid, player_b_name, player_b_elo_before, player_b_elo_after,
     rated
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const matchesByPlayerStmt: StatementSync = db.prepare(
  `SELECT * FROM matches
   WHERE player_a_uuid = ? OR player_b_uuid = ?
   ORDER BY ended_at DESC LIMIT ?`,
);
const matchesAllStmt: StatementSync = db.prepare(
  `SELECT * FROM matches ORDER BY ended_at DESC LIMIT ? OFFSET ?`,
);
const matchesByNameStmt: StatementSync = db.prepare(
  `SELECT * FROM matches
   WHERE player_a_name LIKE ? OR player_b_name LIKE ?
   ORDER BY ended_at DESC LIMIT ? OFFSET ?`,
);
const matchByIdStmt: StatementSync = db.prepare(`SELECT * FROM matches WHERE id = ?`);
const matchCountStmt: StatementSync = db.prepare(`SELECT COUNT(*) AS c FROM matches`);
const matchCountByNameStmt: StatementSync = db.prepare(
  `SELECT COUNT(*) AS c FROM matches WHERE player_a_name LIKE ? OR player_b_name LIKE ?`,
);
const searchPlayersStmt: StatementSync = db.prepare(
  `SELECT * FROM players WHERE name LIKE ? ORDER BY elo DESC LIMIT ?`,
);

export function getOrCreatePlayer(uuid: string, name: string): PlayerRow {
  const row = getPlayerStmt.get(uuid) as unknown as PlayerRow | undefined;
  if (row) {
    if (row.name !== name) {
      updatePlayerNameStmt.run(name, Date.now(), uuid);
      row.name = name;
    }
    return row;
  }
  const now = Date.now();
  insertPlayerStmt.run(uuid, name, DEFAULT_ELO, now);
  return {
    uuid, name, elo: DEFAULT_ELO, games_played: 0,
    wins: 0, losses: 0, draws: 0, updated_at: now,
  };
}

export function getPlayer(uuid: string): PlayerRow | undefined {
  return getPlayerStmt.get(uuid) as unknown as PlayerRow | undefined;
}

/** Applies a result for a single player. `outcome` is 1 for win, -1 for loss, 0 for draw. */
export function applyMatchResult(
  uuid: string,
  newElo: number,
  outcome: 1 | -1 | 0,
): void {
  applyMatchResultStmt.run(
    newElo,
    outcome === 1 ? 1 : 0,
    outcome === -1 ? 1 : 0,
    outcome === 0 ? 1 : 0,
    Date.now(),
    uuid,
  );
}

export function getLeaderboard(limit: number): PlayerRow[] {
  return leaderboardStmt.all(Math.max(1, Math.min(200, limit))) as unknown as PlayerRow[];
}

export interface NewMatchRow {
  roomCode: string | null;
  seed: string | null;
  startedAt: number | null;
  endedAt: number;
  winnerSide: string | null;
  reason: string | null;
  settingsJson: string;
  boardJson: string;
  claimedJson: string;
  playerAUuid: string | null;
  playerAName: string | null;
  playerAEloBefore: number | null;
  playerAEloAfter: number | null;
  playerBUuid: string | null;
  playerBName: string | null;
  playerBEloBefore: number | null;
  playerBEloAfter: number | null;
  rated: boolean;
}

export function recordMatch(m: NewMatchRow): void {
  insertMatchStmt.run(
    m.roomCode, m.seed, m.startedAt, m.endedAt, m.winnerSide, m.reason,
    m.settingsJson, m.boardJson, m.claimedJson,
    m.playerAUuid, m.playerAName, m.playerAEloBefore, m.playerAEloAfter,
    m.playerBUuid, m.playerBName, m.playerBEloBefore, m.playerBEloAfter,
    m.rated ? 1 : 0,
  );
}

export function getRecentMatches(uuid: string, limit: number): MatchRow[] {
  return matchesByPlayerStmt.all(uuid, uuid, Math.max(1, Math.min(100, limit))) as unknown as MatchRow[];
}

export function getAllMatches(limit: number, offset: number): MatchRow[] {
  const lim = Math.max(1, Math.min(100, limit));
  const off = Math.max(0, offset);
  return matchesAllStmt.all(lim, off) as unknown as MatchRow[];
}

export function getMatchesByPlayerName(name: string, limit: number, offset: number): MatchRow[] {
  const lim = Math.max(1, Math.min(100, limit));
  const off = Math.max(0, offset);
  const pattern = `%${name}%`;
  return matchesByNameStmt.all(pattern, pattern, lim, off) as unknown as MatchRow[];
}

export function getMatchById(id: number): MatchRow | undefined {
  return matchByIdStmt.get(id) as unknown as MatchRow | undefined;
}

export function getMatchCount(playerName?: string): number {
  if (playerName) {
    const pattern = `%${playerName}%`;
    const row = matchCountByNameStmt.get(pattern, pattern) as unknown as { c: number };
    return row.c;
  }
  const row = matchCountStmt.get() as unknown as { c: number };
  return row.c;
}

export function searchPlayersByName(query: string, limit: number): PlayerRow[] {
  return searchPlayersStmt.all(`%${query}%`, Math.max(1, Math.min(100, limit))) as unknown as PlayerRow[];
}
