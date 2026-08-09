import { randomBytes } from "node:crypto";

/**
 * Account verification against Mojang's session service.
 *
 * The mod never sends us a password or a token. It uses the *already authenticated*
 * session inside the running game: we hand out a one-time nonce, the client calls
 * Mojang's `joinServer` with it, and we then ask Mojang `hasJoined` whether that
 * username really did join under that nonce. A yes proves the client controls the
 * account. This is the same handshake a normal Minecraft server performs, minus the
 * encryption step we have no use for.
 *
 * What this buys: before it, `uuid` was whatever the client typed. Anyone could claim
 * any account and move a stranger's rating. After it, the only UUID the server will
 * attach to a session is one Mojang confirmed.
 */

const SESSION_SERVER = "https://sessionserver.mojang.com/session/minecraft/hasJoined";

/**
 * How long an issued nonce stays usable. The client's round trip to Mojang is a few
 * hundred milliseconds; anything beyond this is a stale or replayed attempt.
 */
const CHALLENGE_TTL_MS = 30_000;

/** Give up on Mojang rather than letting a hung request hold a connection open. */
const SESSION_TIMEOUT_MS = 5_000;

export interface VerifiedAccount {
  readonly uuid: string;
  readonly name: string;
}

export type AuthOutcome =
  | { readonly ok: true; readonly account: VerifiedAccount }
  | { readonly ok: false; readonly reason: AuthFailure };

export type AuthFailure =
  | "no_challenge"
  | "challenge_expired"
  | "not_verified"
  | "session_server_unavailable";

/**
 * A pending challenge. One per connection: issuing a second one invalidates the first,
 * so a client can't keep a pool of nonces alive to replay later.
 */
export interface AuthChallenge {
  readonly serverId: string;
  readonly issuedAt: number;
}

/** Mint a fresh challenge. The nonce is opaque to the client — it only echoes it back. */
export function issueChallenge(): AuthChallenge {
  return { serverId: randomBytes(20).toString("hex"), issuedAt: Date.now() };
}

/**
 * Ask Mojang whether `username` joined under this challenge.
 *
 * `username` comes from the client and is deliberately untrusted: it is only a lookup
 * key. The proof is the nonce — Mojang will only confirm the pair if that account's
 * session really did call joinServer with it, and the nonce never left this server
 * except to that one connection.
 *
 * A session-server outage returns `session_server_unavailable` rather than a pass. The
 * caller treats that as unauthenticated, which (because authentication only gates
 * *rated* play) degrades to unranked matches instead of an outage of our own.
 */
export async function verifyChallenge(
  challenge: AuthChallenge | null,
  username: string,
): Promise<AuthOutcome> {
  if (!challenge) return { ok: false, reason: "no_challenge" };
  if (Date.now() - challenge.issuedAt > CHALLENGE_TTL_MS) {
    return { ok: false, reason: "challenge_expired" };
  }

  const url = `${SESSION_SERVER}?username=${encodeURIComponent(username)}`
    + `&serverId=${encodeURIComponent(challenge.serverId)}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(SESSION_TIMEOUT_MS) });
  } catch (e) {
    console.warn(`[auth] session server unreachable: ${(e as Error).message}`);
    return { ok: false, reason: "session_server_unavailable" };
  }

  // 204 with an empty body is Mojang's "that account did not join" answer.
  if (response.status === 204) return { ok: false, reason: "not_verified" };
  if (!response.ok) {
    console.warn(`[auth] session server returned ${response.status}`);
    return { ok: false, reason: "session_server_unavailable" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "not_verified" };
  }

  const account = readProfile(body);
  if (!account) return { ok: false, reason: "not_verified" };
  return { ok: true, account };
}

/**
 * Pull the profile out of a hasJoined response. Mojang returns the UUID undashed
 * (`4b072de882974c9a845dad94e38f95b3`); everything else in this codebase — the database,
 * the REST routes, the mod — uses the dashed form, so it is normalised here rather than
 * at each use site.
 */
function readProfile(body: unknown): VerifiedAccount | null {
  if (typeof body !== "object" || body === null) return null;
  const { id, name } = body as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (!/^[0-9a-fA-F]{32}$/.test(id)) return null;
  return { uuid: dashUuid(id), name };
}

export function dashUuid(undashed: string): string {
  return [
    undashed.slice(0, 8), undashed.slice(8, 12), undashed.slice(12, 16),
    undashed.slice(16, 20), undashed.slice(20),
  ].join("-").toLowerCase();
}
