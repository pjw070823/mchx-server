import type { RoomSettings } from "./protocol.js";
import { meetsTier, type Tier } from "./entitlements.js";

/**
 * Which room settings exist, who may change them, and what counts as a valid value.
 *
 * The previous shape was six hand-written `if (patch.x != null) next.x = patch.x`
 * lines inside `Room.updateSettings`. That works for six booleans and falls apart the
 * moment options grow (spectator limits, room names, seed selection) or become
 * tier-gated — each new field would be another line to remember in another file.
 *
 * Declaring the rules as data means adding an option is one entry here, and the
 * question "what does a supporter actually get?" has a single readable answer.
 */
interface FieldRule<K extends keyof RoomSettings> {
  /** Minimum tier allowed to change this field. */
  readonly requiredTier: Tier;
  /** Extra validation beyond the Zod schema, if the value range is narrower. */
  readonly accepts?: (value: RoomSettings[K]) => boolean;
}

type Policy = { readonly [K in keyof RoomSettings]: FieldRule<K> };

/**
 * Everything is `free` today, which preserves the previous behaviour exactly: any
 * host could toggle any setting. The gate is wired and unused on purpose — flipping
 * a field to `tier1` is the whole change when supporter perks ship.
 */
export const SETTINGS_POLICY: Policy = {
  gameMode: { requiredTier: "free" },
  inventorySave: { requiredTier: "free" },
  saturation: { requiredTier: "free" },
  nightVision: { requiredTier: "free" },
  waterBreathing: { requiredTier: "free" },
  rated: { requiredTier: "free" },
};

/**
 * The fixed ladder preset.
 *
 * Identical to `DEFAULT_SETTINGS` today, and deliberately *not* the same constant.
 * `DEFAULT_SETTINGS` is where a custom room starts and is expected to drift as tier
 * options land; the ladder must not drift with it. Free perk choice would also make
 * leaderboard positions incomparable — two players at the same rating would have been
 * playing different games.
 *
 * `rated: true` here, plus `Room.updateSettings` refusing outright for ranked rooms,
 * is what makes it impossible for a player to opt a ranked match out of rating.
 */
export const RANKED_SETTINGS: RoomSettings = {
  gameMode: "1v1",
  inventorySave: true,
  saturation: true,
  nightVision: true,
  waterBreathing: true,
  rated: true,
};

export interface PatchResult {
  /** The settings after applying every field the requester was allowed to change. */
  readonly settings: RoomSettings;
  /** Fields dropped because the requester's tier was too low. */
  readonly deniedByTier: readonly string[];
}

/**
 * Apply `patch` to `current` under the rules of [SETTINGS_POLICY].
 *
 * Unknown keys are ignored (the Zod schema already rejected them upstream), and a
 * field the requester can't afford is skipped rather than failing the whole patch —
 * a client shouldn't be able to lose its other toggles by including one it can't set.
 */
export function applySettingsPatch(
  current: RoomSettings,
  patch: Partial<RoomSettings>,
  tier: Tier,
): PatchResult {
  const settings: RoomSettings = { ...current };
  const deniedByTier: string[] = [];

  for (const key of Object.keys(SETTINGS_POLICY) as Array<keyof RoomSettings>) {
    const value = patch[key];
    if (value == null) continue;

    const rule = SETTINGS_POLICY[key] as FieldRule<typeof key>;
    if (!meetsTier(tier, rule.requiredTier)) {
      deniedByTier.push(key);
      continue;
    }
    if (rule.accepts && !rule.accepts(value as never)) continue;

    // Safe: `key` indexes both objects and `value` came from the same field.
    (settings as Record<string, unknown>)[key] = value;
  }

  return { settings, deniedByTier };
}
