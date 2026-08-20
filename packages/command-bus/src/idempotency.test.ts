// Actor-scoping of the idempotency identity (pentest M).
//
// The security property under test: a stored idempotency row is
// reachable ONLY by the actor that created it. The route-built key
// is resource + minute scoped and NOT actor scoped, so without this
// binding two operators acting on the same resource in the same
// minute produced the same key and the second replayed the first's
// response — skipping its own authorization and audit.

import { describe, expect, it } from "vitest";

import { actorScopedIdempotencyKey } from "./idempotency.js";

const RAW = "pv1-approve:order-1:abc123:29321104";

describe("actorScopedIdempotencyKey", () => {
  it("binds the acting user so two actors get DIFFERENT stored keys for one raw key", () => {
    const a = actorScopedIdempotencyKey("11111111-1111-7111-a111-111111111111", RAW);
    const b = actorScopedIdempotencyKey("22222222-2222-7222-a222-222222222222", RAW);

    expect(a).not.toEqual(b);
    // Neither actor's stored key is the bare raw key, so a lookup by
    // one actor can never select the other's row.
    expect(a).not.toEqual(RAW);
    expect(b).not.toEqual(RAW);
  });

  it("is stable for the same actor + key (an honest retry still replays)", () => {
    const first = actorScopedIdempotencyKey("11111111-1111-7111-a111-111111111111", RAW);
    const again = actorScopedIdempotencyKey("11111111-1111-7111-a111-111111111111", RAW);
    expect(first).toEqual(again);
  });

  it("collapses system commands (null actor) to a single `sys` segment", () => {
    // System idempotency is keyed on an external event id (e.g. a
    // Stripe event) and has no differing actor to isolate; every
    // system attempt must still share one identity so it dedups.
    const s1 = actorScopedIdempotencyKey(null, "stripe-event:evt_1");
    const s2 = actorScopedIdempotencyKey(null, "stripe-event:evt_1");
    expect(s1).toEqual(s2);
    expect(s1.startsWith("sys|")).toBe(true);
  });

  it("cannot let a user collide with the system segment", () => {
    const user = actorScopedIdempotencyKey("sys", RAW);
    const system = actorScopedIdempotencyKey(null, RAW);
    // Even a (hypothetical) user id of "sys" is prefixed `u:`, so it
    // never shares an identity with a real system command.
    expect(user).not.toEqual(system);
    expect(user.startsWith("u:")).toBe(true);
  });

  it("uses a separator that never appears in a UUID or route key segment", () => {
    const composed = actorScopedIdempotencyKey("11111111-1111-7111-a111-111111111111", RAW);
    // Exactly one `|` (our separator); the raw key never contains one.
    expect(composed.split("|")).toHaveLength(2);
    expect(RAW.includes("|")).toBe(false);
  });
});
