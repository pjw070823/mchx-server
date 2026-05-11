import { z } from "zod";

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

export const RoomSettings = z.object({
  gameMode: z.enum(["1v1", "2v2"]),
  inventorySave: z.boolean(),
  saturation: z.boolean(),
  rated: z.boolean(),
});
export type RoomSettings = z.infer<typeof RoomSettings>;

export const DEFAULT_SETTINGS: RoomSettings = {
  gameMode: "1v1",
  inventorySave: false,
  saturation: false,
  rated: true,
};

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
    type: z.literal("create_room"),
    playerName: z.string().min(1).max(32),
    uuid: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("join_room"),
    roomCode: z.string().length(4),
    playerName: z.string().min(1).max(32),
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
    kind: z.enum(["death", "advancement"]),
    text: z.string().min(1).max(512),
  }),
  z.object({
    type: z.literal("spectate"),
    roomCode: z.string().length(4),
  }),
  z.object({
    type: z.literal("ping"),
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
    type: z.literal("room_state"),
    roomCode: z.string(),
    status: RoomStatus,
    you: PlayerInfo.nullable(),
    opponent: PlayerInfo.nullable(),
    hostId: z.string().nullable(),
    settings: RoomSettings,
  }),
  z.object({
    type: z.literal("match_start"),
    seed: z.bigint(),
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
    kind: z.enum(["death", "advancement"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("pong"),
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
