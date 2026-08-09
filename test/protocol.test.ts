import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decode, encode, DEFAULT_SETTINGS } from "../src/protocol.js";
import type { ServerMessage } from "../src/protocol.js";

/**
 * Contract tests against the mod's wire format.
 *
 * The protocol is written twice — Zod here, kotlinx `@Serializable` classes in
 * `mod/src/main/kotlin/com/mchx/net/Protocol.kt` — and nothing but discipline keeps the
 * two in step. A rename on one side produces no compile error on the other; it produces
 * a mod that silently fails to parse a message mid-match.
 *
 * These tests pin the two directions that actually break:
 *
 *   1. What the mod SENDS must decode here. The fixtures below are literal strings in
 *      the shape kotlinx produces under the mod's `Wire.json` config —
 *      `classDiscriminator = "type"`, `encodeDefaults = true`, `explicitNulls = false`
 *      (so null fields are omitted entirely, and `object` message types serialise to
 *      nothing but their discriminator).
 *
 *   2. What the server SENDS must be decodable there. kotlinx tolerates unknown keys
 *      (`ignoreUnknownKeys = true`) but not *missing* ones: any Kotlin property without
 *      a default must appear in the JSON. The declared shapes below mirror those
 *      properties, so dropping or retyping a field fails here instead of in a match.
 */

// ---------------------------------------------------------------------------
// 1. Client -> server: fixtures exactly as the mod emits them
// ---------------------------------------------------------------------------

/** Message JSON the mod is known to produce, paired with what it must parse to. */
const CLIENT_FIXTURES: ReadonlyArray<{ name: string; json: string; type: string }> = [
  // uuid present
  {
    name: "create_room with uuid",
    json: '{"type":"create_room","playerName":"samarian00","uuid":"4b072de8-8297-4c9a-845d-ad94e38f95b3"}',
    type: "create_room",
  },
  // explicitNulls=false: a null uuid is omitted rather than sent as null. Zod uses
  // `.optional()`, which rejects an explicit null — so this omission is load-bearing.
  {
    name: "create_room without uuid",
    json: '{"type":"create_room","playerName":"Bob"}',
    type: "create_room",
  },
  {
    name: "join_room",
    json: '{"type":"join_room","roomCode":"TFQY","playerName":"Bob","uuid":"4b072de8-8297-4c9a-845d-ad94e38f95b3"}',
    type: "join_room",
  },
  // Kotlin `object` variants carry the discriminator and nothing else.
  { name: "leave_room", json: '{"type":"leave_room"}', type: "leave_room" },
  { name: "start_match", json: '{"type":"start_match"}', type: "start_match" },
  { name: "world_ready", json: '{"type":"world_ready"}', type: "world_ready" },
  { name: "ping", json: '{"type":"ping"}', type: "ping" },
  // RoomSettingsPatch: only the toggled field survives explicitNulls=false.
  {
    name: "update_settings single field",
    json: '{"type":"update_settings","settings":{"rated":false}}',
    type: "update_settings",
  },
  {
    name: "update_settings full",
    json: '{"type":"update_settings","settings":{"gameMode":"1v1","inventorySave":true,"saturation":true,"nightVision":true,"waterBreathing":true,"rated":true}}',
    type: "update_settings",
  },
  { name: "claim", json: '{"type":"claim","tileId":"2,2","missionId":"easy_cookie"}', type: "claim" },
  { name: "chat", json: '{"type":"chat","text":"hello"}', type: "chat" },
  {
    name: "world_event death",
    json: '{"type":"world_event","kind":"death","text":"samarian00이(가) 용암에 빠졌습니다"}',
    type: "world_event",
  },
  { name: "world_event forfeit", json: '{"type":"world_event","kind":"forfeit","text":"항복"}', type: "world_event" },
  { name: "spectate", json: '{"type":"spectate","roomCode":"TFQY"}', type: "spectate" },
];

describe("protocol contract — messages the mod sends", () => {
  for (const fixture of CLIENT_FIXTURES) {
    it(`accepts ${fixture.name}`, () => {
      const parsed = decode(fixture.json);
      assert.ok(parsed, `mod-shaped ${fixture.name} failed to decode`);
      assert.equal(parsed.type, fixture.type);
    });
  }

  it("tolerates an explicit null uuid — that field is nullable as well as optional", () => {
    // Protocol.kt claims the server "rejects explicit null", which is only half true.
    // `uuid` is `.nullable().optional()`, so a null here is fine.
    assert.ok(decode('{"type":"create_room","playerName":"Bob","uuid":null}'));
    assert.ok(decode('{"type":"join_room","roomCode":"TFQY","playerName":"Bob","uuid":null}'));
  });

  it("rejects a null inside a settings patch — this is what explicitNulls=false buys", () => {
    // `RoomSettings.partial()` makes fields optional but NOT nullable. If the mod ever
    // turned explicitNulls back on, every settings toggle would start failing
    // validation outright, because the untouched fields would ship as nulls.
    assert.equal(decode('{"type":"update_settings","settings":{"rated":null}}'), null);
    assert.ok(decode('{"type":"update_settings","settings":{}}'), "an empty patch is legal");
  });

  it("rejects unknown message types rather than throwing", () => {
    assert.equal(decode('{"type":"definitely_not_a_message"}'), null);
    assert.equal(decode("not json at all"), null);
  });

  it("holds the mod to the room-code length it types into the join box", () => {
    assert.equal(decode('{"type":"join_room","roomCode":"TOOLONG","playerName":"Bob"}'), null);
  });
});

// ---------------------------------------------------------------------------
// 2. Server -> client: every field the mod's Kotlin classes require
// ---------------------------------------------------------------------------

type FieldType = "string" | "number" | "boolean" | "object" | "array" | "nullable";

/**
 * Properties the mod declares without a default. kotlinx treats a missing one as a
 * decode failure, so each must appear in the encoded JSON with the stated type.
 */
const SERVER_REQUIRED: ReadonlyArray<{
  name: string;
  msg: ServerMessage;
  required: Readonly<Record<string, FieldType>>;
}> = [
  {
    name: "error",
    msg: { type: "error", code: "room_full", message: "room already has 2 players" },
    required: { code: "string", message: "string" },
  },
  {
    name: "room_state",
    msg: {
      type: "room_state",
      roomCode: "TFQY",
      status: "waiting",
      you: { id: "p1", name: "samarian00", side: "A", uuid: null, elo: 500 },
      opponent: null,
      hostId: "p1",
      settings: DEFAULT_SETTINGS,
    },
    required: { roomCode: "string", status: "string", settings: "object" },
  },
  {
    name: "match_start",
    msg: {
      type: "match_start",
      seed: -3592256889487318181n,
      yourSide: "A",
      board: [{ tileId: "0,0", q: 0, r: 0, difficulty: "easy", missionId: "easy_cookie" }],
      claimed: [],
      settings: DEFAULT_SETTINGS,
      startsAt: 1_700_000_000_000,
    },
    // `seed` is a STRING on the wire: JSON has no 64-bit integer, and the mod parses it
    // with String.toLong. Encoding it as a number would silently break every match.
    required: { seed: "string", board: "array", claimed: "array", settings: "object", startsAt: "number" },
  },
  {
    name: "countdown_start",
    msg: { type: "countdown_start", startsAt: 1_700_000_000_000 },
    required: { startsAt: "number" },
  },
  {
    name: "tile_claimed",
    msg: { type: "tile_claimed", tileId: "0,0", side: "A", missionId: "easy_cookie", claimedAt: 1 },
    required: { tileId: "string", side: "string", missionId: "string", claimedAt: "number" },
  },
  {
    name: "claim_rejected",
    msg: { type: "claim_rejected", tileId: "0,0", reason: "already_claimed" },
    required: { tileId: "string", reason: "string" },
  },
  {
    name: "match_end",
    msg: {
      type: "match_end",
      winner: "A",
      reason: "connection",
      eloChanges: { p1: { before: 500, after: 520, delta: 20 } },
    },
    required: { reason: "string", eloChanges: "object" },
  },
  {
    name: "chat_message",
    msg: { type: "chat_message", senderId: "p1", senderName: "Bob", text: "hi" },
    required: { senderId: "string", senderName: "string", text: "string" },
  },
  {
    name: "world_event_message",
    msg: { type: "world_event_message", senderId: "p1", senderName: "Bob", kind: "death", text: "died" },
    required: { senderId: "string", senderName: "string", kind: "string", text: "string" },
  },
  { name: "pong", msg: { type: "pong" }, required: {} },
];

describe("protocol contract — messages the server sends", () => {
  for (const { name, msg, required } of SERVER_REQUIRED) {
    it(`${name} carries every field the mod requires`, () => {
      const wire = JSON.parse(encode(msg)) as Record<string, unknown>;

      assert.equal(wire.type, msg.type, "the discriminator must be `type`");

      for (const [field, kind] of Object.entries(required)) {
        assert.ok(field in wire, `${name} is missing required field '${field}'`);
        const value = wire[field];
        switch (kind) {
          case "array":
            assert.ok(Array.isArray(value), `${name}.${field} must be an array`);
            break;
          case "object":
            assert.equal(typeof value, "object", `${name}.${field} must be an object`);
            assert.ok(value !== null, `${name}.${field} must not be null`);
            break;
          default:
            assert.equal(typeof value, kind, `${name}.${field} must be a ${kind}`);
        }
      }
    });
  }

  it("encodes the 64-bit seed as a string, not a number", () => {
    const seed = -3592256889487318181n;
    const wire = JSON.parse(encode({
      type: "match_start",
      seed,
      yourSide: null,
      board: [],
      claimed: [],
      settings: DEFAULT_SETTINGS,
      startsAt: 0,
    })) as { seed: unknown };

    assert.equal(typeof wire.seed, "string");
    // Round-trips exactly — a number would have lost precision at this magnitude.
    assert.equal(BigInt(wire.seed as string), seed);
  });

  it("sends settings with every field the mod's RoomSettings names", () => {
    const wire = JSON.parse(encode({
      type: "room_state",
      roomCode: "TFQY",
      status: "waiting",
      you: null,
      opponent: null,
      hostId: null,
      settings: DEFAULT_SETTINGS,
    })) as { settings: Record<string, unknown> };

    for (const field of ["gameMode", "inventorySave", "saturation", "nightVision", "waterBreathing", "rated"]) {
      assert.ok(field in wire.settings, `settings is missing '${field}'`);
    }
  });

  it("uses the exact enum spellings the mod's @SerialName annotations expect", () => {
    // Kotlin maps these strings to enum constants; a case change breaks decoding.
    const statuses = ["waiting", "starting", "playing", "ended"];
    for (const status of statuses) {
      const wire = JSON.parse(encode({
        type: "room_state",
        roomCode: "TFQY",
        status: status as never,
        you: null,
        opponent: null,
        hostId: null,
        settings: DEFAULT_SETTINGS,
      })) as { status: string };
      assert.equal(wire.status, status);
    }

    const wire = JSON.parse(encode({
      type: "tile_claimed", tileId: "0,0", side: "B", missionId: "m", claimedAt: 0,
    })) as { side: string };
    assert.equal(wire.side, "B", "sides are uppercase A/B");
  });
});
