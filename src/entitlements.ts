/**
 * What a given account is entitled to.
 *
 * This is a deliberate stub: every lookup returns `free` today. It exists so the
 * *shape* of tier-gated features is settled before the features arrive, and so the
 * gate has exactly one implementation to replace rather than a dozen call sites to
 * find later.
 *
 * Two rules the eventual implementation must keep:
 *
 *  1. **Entitlements are server-side facts.** They are never read from a client
 *     message. A mod can claim any UUID it likes until account verification lands
 *     (see the auth work), so trusting a client-declared tier would hand out paid
 *     features for free.
 *  2. **Nothing gated here may affect a ranked result.** Tiers may unlock private
 *     room options, cosmetics and convenience — never anything that changes who wins
 *     a rated match.
 */

/** Ordered from least to most privileged; the order is what [meetsTier] compares. */
export const TIERS = ["free", "tier1", "tier2"] as const;

export type Tier = (typeof TIERS)[number];

/**
 * The tier for a Minecraft account UUID.
 *
 * Always `free` until there is (a) verified account identity and (b) a store to read
 * purchases from. Callers should already be written as if the answer varies.
 */
export function tierOf(_uuid: string | null): Tier {
  return "free";
}

/** True if `actual` is at least as privileged as `required`. */
export function meetsTier(actual: Tier, required: Tier): boolean {
  return TIERS.indexOf(actual) >= TIERS.indexOf(required);
}
