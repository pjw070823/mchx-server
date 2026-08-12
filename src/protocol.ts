import { z } from "zod";

/**
 * Wire compatibility version, sent by the mod in `hello`.
 *
 * Bump it whenever a change would make an older mod misbehave rather than merely miss a
 * feature — a renamed field, a new required field, changed semantics. The server refuses
 * anything it doesn't recognise, so a stale client gets a clear message instead of
 * failing halfway through a match.
 *
 * 1 — first versioned protocol; adds the `hello` handshake and account verification.
 * 2 — ranked queue: `join_queue`/`leave_queue`/`queue_state`, and `room_state.origin`.
 *
 * A v1 client is still served (see MIN_SUPPORTED_PROTOCOL); it simply never sends the
 * queue messages. The bump exists so `hello_ok.protocolVersion` works as a capability
 * signal — the mod greys out 랭크전 against an older server and says why, rather than
 * opening a queue screen that hangs on `bad_message`.
 */
export const PROTOCOL_VERSION = 2;

export const Difficulty = z.enum(["easy", "medium", "hard"]);
export type Difficulty = z.infer<typeof Difficulty>;

export const Side = z.enum(["A", "B"]);
export type Side = z.infer<typeof Side>;

export const TileId = z.string().regex(/^[0-4],[0-4]$/);
export type TileId = z.infer<typeof TileId>;

export const PlayerInfo = z.object({
  id: z.string(),
  name: z.string(),
  side: Side.nullable(),
  uuid: z.string().nullable(),
  elo: z.number().int().nullable(),
});
export type PlayerInfo = z.infer<typeof PlayerInfo>;

/**
 * What the players agreed to play.
 *
 * Deliberately no `rated` flag: whether a match counts is decided by `room_state.origin`,
 * not by a toggle. Custom rooms are never rated — you pick your own opponent and your own
 * perks there — and ranked rooms always are. A boolean that can only ever hold one value
 * per origin is a second source of truth waiting to disagree with the first.
 */
export const RoomSettings = z.object({
  gameMode: z.enum(["1v1", "2v2"]),
  inventorySave: z.boolean(),
  saturation: z.boolean(),
  nightVision: z.boolean(),
  waterBreathing: z.boolean(),
});
export type RoomSettings = z.infer<typeof RoomSettings>;

export const DEFAULT_SETTINGS: RoomSettings = {
  gameMode: "1v1",
  inventorySave: true,
  saturation: true,
  nightVision: true,
  waterBreathing: true,
};

/** Mirrors `RoomOrigin` in room-config.ts. Declared here so it can cross the wire. */
export const RoomOriginSchema = z.enum(["custom", "ranked"]);

export const EloChange = z.object({
  before: z.number().int(),
  after: z.number().int(),
  delta: z.number().int(),
});
export type EloChange = z.infer<typeof EloChange>;

export const BoardTile = z.object({
  tileId: TileId,
  q: z.number().int().min(0).max(4),
  r: z.number().int().min(0).max(4),
  difficulty: Difficulty,
  missionId: z.string(),
});
export type BoardTile = z.infer<typeof BoardTile>;

export const ClaimedTile = z.object({
  tileId: TileId,
  side: Side,
  missionId: z.string(),
  claimedAt: z.number().int(),
});
export type ClaimedTile = z.infer<typeof ClaimedTile>;

export const RoomStatus = z.enum(["waiting", "starting", "playing", "ended"]);
export type RoomStatus = z.infer<typeof RoomStatus>;

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.number().int().min(0),
    /** Free-form build identifier, logged only. */
    clientVersion: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal("auth_begin"),
  }),
  z.object({
    type: z.literal("auth_verify"),
    /** Untrusted; only a lookup key for the hasJoined call. The nonce is the proof. */
    playerName: z.string().min(1).max(32),
  }),
  z.object({
    type: z.literal("create_room"),
    playerName: z.string().min(1).max(32),
    // Accepted for backwards compatibility and IGNORED. The only uuid the server will
    // attach to a session comes from Mojang via `auth_verify`; trusting this field is
    // what let anyone claim any account.
    uuid: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("join_room"),
    roomCode: z.string().length(4),
    playerName: z.string().min(1).max(32),
    /** Ignored — see `create_room`. */
    uuid: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("leave_room"),
  }),
  z.object({
    type: z.literal("update_settings"),
    settings: RoomSettings.partial(),
  }),
  z.object({
    type: z.literal("start_match"),
  }),
  z.object({
    type: z.literal("world_ready"),
  }),
  z.object({
    type: z.literal("claim"),
    tileId: TileId,
    missionId: z.string(),
  }),
  z.object({
    type: z.literal("chat"),
    text: z.string().min(1).max(256),
  }),
  z.object({
    type: z.literal("world_event"),
    kind: z.enum(["death", "advancement", "forfeit"]),
    text: z.string().min(1).max(512),
  }),
  z.object({
    type: z.literal("spectate"),
    roomCode: z.string().length(4),
  }),
  z.object({
    type: z.literal("ping"),
  }),
  /**
   * Enter the ranked queue.
   *
   * Deliberately field-less. Identity comes only from the verified account on the
   * connection — a `playerName` here would be ignored, which is exactly the confusion
   * `create_room.uuid` already causes. No mode field either: the ladder preset is fixed,
   * and a 2v2 ladder would be a second queue rather than a parameter on this one.
   */
  z.object({
    type: z.literal("join_queue"),
  }),
  z.object({
    type: z.literal("leave_queue"),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("hello_ok"),
    protocolVersion: z.number().int(),
  }),
  z.object({
    type: z.literal("auth_challenge"),
    /** One-time nonce the client passes to Mojang's joinServer. */
    serverId: z.string(),
  }),
  z.object({
    type: z.literal("auth_result"),
    authenticated: z.boolean(),
    /** Mojang-confirmed account, or null when verification failed. */
    uuid: z.string().nullable(),
    name: z.string().nullable(),
    /** Machine-readable failure cause; null on success. */
    reason: z.string().nullable(),
  }),
  z.object({
    type: z.literal("room_state"),
    roomCode: z.string(),
    status: RoomStatus,
    /**
     * How the room was made.
     *
     * The mod needs this to decide where a finished match returns to — the room screen
     * for a custom game, the match menu for a ranked one — and whether leaving the world
     * should send `leave_room`. Tracking "I came from the queue" client-side would mean
     * clearing that flag on five separate exit paths; the server already knows.
     */
    origin: RoomOriginSchema,
    you: PlayerInfo.nullable(),
    opponent: PlayerInfo.nullable(),
    hostId: z.string().nullable(),
    settings: RoomSettings,
  }),
  z.object({
    type: z.literal("match_start"),
    /**
     * Null for spectators. The seed reproduces the whole world, so handing it to an
     * onlooker hands it to whoever they are relaying for.
     */
    seed: z.bigint().nullable(),
    yourSide: Side.nullable(),
    board: z.array(BoardTile),
    claimed: z.array(ClaimedTile),
    settings: RoomSettings,
    startsAt: z.number().int(),
  }),
  z.object({
    type: z.literal("countdown_start"),
    startsAt: z.number().int(),
  }),
  z.object({
    type: z.literal("tile_claimed"),
    tileId: TileId,
    side: Side,
    missionId: z.string(),
    claimedAt: z.number().int(),
  }),
  z.object({
    type: z.literal("claim_rejected"),
    tileId: TileId,
    reason: z.string(),
  }),
  z.object({
    type: z.literal("match_end"),
    winner: Side.nullable(),
    reason: z.enum(["connection", "forfeit", "disconnect"]),
    eloChanges: z.record(z.string(), EloChange),
  }),
  z.object({
    type: z.literal("chat_message"),
    senderId: z.string(),
    senderName: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("world_event_message"),
    senderId: z.string(),
    senderName: z.string(),
    kind: z.enum(["death", "advancement", "forfeit"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("pong"),
  }),
  /**
   * The queue's view of this connection. Sent on entry, every few seconds while waiting,
   * and once more when the slot ends.
   *
   * `queued: false` with `reason: "matched"` is immediately followed by `room_state` and
   * `match_start` — the client should not treat it as a return to idle.
   */
  z.object({
    type: z.literal("queue_state"),
    queued: z.boolean(),
    /** Why the slot ended. Null while still queued. */
    reason: z.enum(["cancelled", "matched", "disconnected", "closed"]).nullable(),
    /** Server-measured wait. The client extrapolates with its own clock, not this epoch. */
    waitingMs: z.number().int(),
    /** People queued, including this one. */
    size: z.number().int(),
    /** Rating snapshot taken at entry — what the search is actually centred on. */
    elo: z.number().int(),
    /** Current ELO search half-width, so the wait is legible rather than mysterious. */
    window: z.number().int(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function decode(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw);
    const result = ClientMessage.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
