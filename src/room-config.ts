/**
 * Tunables that govern a room's pacing and limits.
 *
 * Production always uses [DEFAULT_ROOM_CONFIG]; the per-room override exists so tests
 * can shrink the multi-second gates — a suite can't wait out a 15-second anti-cheat
 * window to make one legal claim — without resorting to fake timers.
 *
 * Separate module so the match engine can read the type without importing Room.
 */
export interface RoomConfig {
  /** Hard cap on spectators per room, so one attacker can't fan out broadcasts. */
  maxSpectators: number;
  /**
   * Grace period after a player's socket closes before the match is forfeited. Short
   * enough that a deliberate quit still feels responsive, long enough to ride out a
   * network blip. An explicit `leave_room` bypasses it entirely.
   */
  reconnectGraceMs: number;
  /**
   * Anti-cheat time gates on `claim`. Real play cannot complete a mission inside
   * minTimeToFirstClaimMs, nor chain claims faster than minIntervalBetweenClaimsMs.
   * Both are conservative — a legitimate fast start won't trip them, a script firing
   * all 25 claims at t=0 will.
   */
  minTimeToFirstClaimMs: number;
  minIntervalBetweenClaimsMs: number;
  /** Pre-match countdown, once every player has reported `world_ready`. */
  countdownMs: number;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  maxSpectators: 50,
  reconnectGraceMs: 10_000,
  minTimeToFirstClaimMs: 15_000,
  minIntervalBetweenClaimsMs: 1_000,
  countdownMs: 5_000,
};

/**
 * How a room came to exist.
 *
 * `custom` — someone pressed 방 생성. There is a host, and only they may change
 * settings or start the match.
 *
 * `ranked` — the matchmaker built it from the queue. There is no host: settings come
 * from the ladder and the match starts on its own. Nothing creates these yet; the
 * distinction exists so the host-only guards have somewhere to *not* apply, rather
 * than being rewritten when the queue lands.
 */
export type RoomOrigin = "custom" | "ranked";
