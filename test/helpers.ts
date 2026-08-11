import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WebSocket } from "ws";
// Type-only imports ONLY in this file. Anything that pulls `room.ts` in for real would
// load `db.ts`, which opens (and migrates) its SQLite file at import time — before the
// env var below has a chance to point it somewhere disposable.
import type { ConnState } from "../src/conn-state.js";
import type { Room, RoomConfig } from "../src/room.js";

/**
 * Point the database at a throwaway directory before any test module graph loads.
 *
 * Every test file must import this module FIRST, then `await import("../src/room.js")`.
 * Only set it if the caller hasn't already, so a suite can pin its own path.
 */
if (!process.env.MCHX_DB_PATH) {
  process.env.MCHX_DB_PATH = join(mkdtempSync(join(tmpdir(), "mchx-test-")), "test.sqlite");
}

export interface Frame {
  type: string;
  [key: string]: unknown;
}

/** Minimal stand-in for a `ws` socket — the server only touches readyState/OPEN/send. */
export class FakeWs {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Frame[] = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Frame);
  }

  /** Simulate the socket dropping. */
  drop(): void {
    this.readyState = 3;
  }

  all(type: string): Frame[] {
    return this.sent.filter((f) => f.type === type);
  }

  last(type: string): Frame | undefined {
    return this.all(type).at(-1);
  }

  /** Where a frame type first appears. -1 if never. Used to pin send ordering. */
  indexOf(type: string): number {
    return this.sent.findIndex((f) => f.type === type);
  }

  clear(): void {
    this.sent.length = 0;
  }

  get ws(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/** Gates collapsed to zero so a test can legally claim immediately. */
export const FAST: Partial<RoomConfig> = {
  minTimeToFirstClaimMs: 0,
  minIntervalBetweenClaimsMs: 0,
  countdownMs: 0,
  reconnectGraceMs: 20,
};

/** Two Mojang-verified accounts, i.e. a match that is allowed to count. */
export const VERIFIED = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
};

export function seat(
  room: Room,
  id: string,
  name: string,
  uuid: string | null = null,
  addr: string | null = null,
) {
  const sock = new FakeWs();
  const session = room.addPlayer(id, name, uuid, sock.ws, addr);
  return { sock, session };
}

export function boardOf(sock: FakeWs): Array<{ tileId: string; missionId: string }> {
  const snapshot = sock.last("match_start");
  assert.ok(snapshot, "expected a match_start snapshot");
  return snapshot.board as Array<{ tileId: string; missionId: string }>;
}

export function missionFor(
  board: Array<{ tileId: string; missionId: string }>,
  tile: string,
): string {
  const found = board.find((t) => t.tileId === tile);
  assert.ok(found, `tile ${tile} missing from board`);
  return found.missionId;
}

/** The straight r=0..4 column that wins for side A. */
export const A_WINNING_CHAIN = ["0,0", "0,1", "0,2", "0,3", "0,4"];

/**
 * A connection as `index.ts` would have built it, plus its socket.
 *
 * `verified` is the only thing that gives a connection an account, so a test that wants
 * a guest simply omits it.
 */
export function fakeConn(
  opts: {
    playerId?: string;
    uuid?: string | null;
    name?: string;
    remoteAddr?: string | null;
    protocolVersion?: number | null;
  } = {},
): { state: ConnState; sock: FakeWs } {
  const sock = new FakeWs();
  const uuid = opts.uuid ?? null;
  const state: ConnState = {
    playerId: opts.playerId ?? "c1",
    room: null,
    isSpectator: false,
    remoteAddr: opts.remoteAddr ?? null,
    tokens: 60,
    lastRefillAt: Date.now(),
    spectateFailCount: 0,
    spectateBlockedUntil: 0,
    protocolVersion: opts.protocolVersion === undefined ? 2 : opts.protocolVersion,
    challenge: null,
    verified: uuid ? { uuid, name: opts.name ?? "Player" } : null,
    queueCooldownUntil: 0,
    isAlive: true,
  };
  return { state, sock };
}

/**
 * Silence the server's per-frame logging so test output stays readable.
 * Call the returned function to restore — a failure report must not be swallowed.
 */
export function muteConsole(): () => void {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  return () => {
    console.log = origLog;
    console.warn = origWarn;
  };
}
