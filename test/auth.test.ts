import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { dashUuid, issueChallenge, verifyChallenge, type AuthChallenge } from "../src/auth.js";

const REAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

/** Replace global fetch, capturing the URL the code under test asked for. */
function stubFetch(handler: (url: string) => Response | Promise<Response> | never): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return handler(String(input));
  }) as typeof fetch;
  return { urls };
}

function profileResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PROFILE = { id: "4b072de882974c9a845dad94e38f95b3", name: "samarian00" };
const DASHED = "4b072de8-8297-4c9a-845d-ad94e38f95b3";

describe("dashUuid", () => {
  it("restores the 8-4-4-4-12 form Mojang strips", () => {
    assert.equal(dashUuid(PROFILE.id), DASHED);
  });

  it("lowercases, so it matches what the database already stores", () => {
    assert.equal(dashUuid(PROFILE.id.toUpperCase()), DASHED);
  });
});

describe("issueChallenge", () => {
  it("mints a distinct nonce every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => issueChallenge().serverId));
    assert.equal(seen.size, 50, "a repeated nonce would make a replay possible");
  });

  it("produces an opaque hex nonce", () => {
    assert.match(issueChallenge().serverId, /^[0-9a-f]{40}$/);
  });
});

describe("verifyChallenge", () => {
  it("accepts a profile the session server confirms", async () => {
    const { urls } = stubFetch(() => profileResponse(PROFILE));
    const challenge = issueChallenge();

    const outcome = await verifyChallenge(challenge, "samarian00");

    assert.ok(outcome.ok);
    assert.deepEqual(outcome.account, { uuid: DASHED, name: "samarian00" });
    // The nonce is the actual proof, so it has to reach Mojang alongside the name.
    assert.match(urls[0]!, new RegExp(`serverId=${challenge.serverId}`));
    assert.match(urls[0]!, /username=samarian00/);
  });

  it("escapes the untrusted username instead of splicing it into the query", async () => {
    const { urls } = stubFetch(() => profileResponse(PROFILE));
    await verifyChallenge(issueChallenge(), "a&serverId=attacker");

    assert.ok(!urls[0]!.includes("a&serverId=attacker"), "raw injection must not survive");
    assert.match(urls[0]!, /username=a%26serverId%3Dattacker/);
  });

  it("refuses when there is no challenge to verify against", async () => {
    stubFetch(() => {
      throw new Error("must not be called");
    });
    const outcome = await verifyChallenge(null, "samarian00");
    assert.deepEqual(outcome, { ok: false, reason: "no_challenge" });
  });

  it("refuses a stale challenge without asking Mojang", async () => {
    const { urls } = stubFetch(() => profileResponse(PROFILE));
    const expired: AuthChallenge = { serverId: "deadbeef", issuedAt: Date.now() - 60_000 };

    const outcome = await verifyChallenge(expired, "samarian00");

    assert.deepEqual(outcome, { ok: false, reason: "challenge_expired" });
    assert.equal(urls.length, 0);
  });

  it("treats 204 as 'that account did not join'", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const outcome = await verifyChallenge(issueChallenge(), "someone_else");
    assert.deepEqual(outcome, { ok: false, reason: "not_verified" });
  });

  it("rejects a malformed profile body", async () => {
    stubFetch(() => profileResponse({ id: "not-a-uuid", name: "x" }));
    assert.deepEqual(await verifyChallenge(issueChallenge(), "x"), { ok: false, reason: "not_verified" });

    stubFetch(() => new Response("not json", { status: 200 }));
    assert.deepEqual(await verifyChallenge(issueChallenge(), "x"), { ok: false, reason: "not_verified" });
  });

  it("reports an outage separately from a rejection", async () => {
    // The distinction matters: a rejection means "this player is lying", an outage means
    // "we can't tell". Both end up unauthenticated, but only one is worth alarming on.
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    assert.deepEqual(
      await verifyChallenge(issueChallenge(), "samarian00"),
      { ok: false, reason: "session_server_unavailable" },
    );

    stubFetch(() => new Response("", { status: 503 }));
    assert.deepEqual(
      await verifyChallenge(issueChallenge(), "samarian00"),
      { ok: false, reason: "session_server_unavailable" },
    );
  });
});
