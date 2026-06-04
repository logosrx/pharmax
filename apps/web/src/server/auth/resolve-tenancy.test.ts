// Contract tests for the operator-tenancy resolver.
//
// Drives the resolver with injected stubs for both Clerk's `auth()`
// and the Pharmax Prisma client surface — no actual Clerk SDK calls,
// no DB roundtrip.

import type { Cache } from "@pharmax/composition";
import { UserStatus } from "@pharmax/database";
import { describe, expect, it, vi } from "vitest";

import { operatorIdentityCacheKey } from "./operator-identity-cache.js";
import {
  RESOLVE_TENANCY_NO_SESSION,
  RESOLVE_TENANCY_USER_NOT_ACTIVE,
  RESOLVE_TENANCY_USER_NOT_LINKED,
  resolveOperatorTenancyContext,
} from "./resolve-tenancy.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const CLERK_USER_ID = "user_2abcXYZ";

// A Map-backed Cache fake (TTL ignored) so the read-through behaviour is
// deterministic and we can assert hits vs. DB loads.
function memoryCache(): Cache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    deletePrefix: vi.fn(async (prefix: string) => {
      for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
    }),
  } as unknown as Cache & { store: Map<string, unknown> };
}

function fakeAuth(userId: string | null): () => Promise<{ userId: string | null }> {
  return vi.fn(async () => ({ userId }));
}

function fakeClient(
  user: {
    id: string;
    organizationId: string;
    email: string;
    displayName: string;
    status: UserStatus;
    clerkUserId: string | null;
  } | null
) {
  const userDelegate = { findUnique: vi.fn(async () => user) };
  return {
    user: userDelegate,
    // The resolver runs the lookup inside a system-GUC transaction;
    // the fake just invokes the callback with a tx exposing
    // `$executeRaw` (for the GUC set) and the same `user` delegate.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ $executeRaw: vi.fn(async () => 0), user: userDelegate })
    ),
  };
}

describe("resolveOperatorTenancyContext — happy path", () => {
  it("returns a TenancyContext + operator metadata for an ACTIVE linked user", async () => {
    const result = await resolveOperatorTenancyContext({
      auth: fakeAuth(CLERK_USER_ID),
      client: fakeClient({
        id: USER_ID,
        organizationId: ORG_ID,
        email: "owner@acme.test",
        displayName: "Acme Owner",
        status: UserStatus.ACTIVE,
        clerkUserId: CLERK_USER_ID,
      }) as never,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrowing for the rest of the test

    expect(result.operator.userId).toBe(USER_ID);
    expect(result.operator.organizationId).toBe(ORG_ID);
    expect(result.operator.clerkUserId).toBe(CLERK_USER_ID);
    expect(result.operator.email).toBe("owner@acme.test");

    // Tenancy context is the standard bus shape.
    expect(result.tenancy.organizationId).toBe(ORG_ID);
    expect(result.tenancy.actor.userId).toBe(USER_ID);
    // correlationId is a fresh ulid; just assert shape.
    expect(result.tenancy.actor.correlationId).toMatch(/^[0-9A-Z]{26}$/);
  });
});

describe("resolveOperatorTenancyContext — failure modes", () => {
  it("returns NO_SESSION when Clerk session is empty", async () => {
    const result = await resolveOperatorTenancyContext({
      auth: fakeAuth(null),
      client: fakeClient(null) as never,
    });
    expect(result).toEqual({ ok: false, reason: RESOLVE_TENANCY_NO_SESSION });
  });

  it("returns USER_NOT_LINKED when Clerk session has no Pharmax row", async () => {
    const result = await resolveOperatorTenancyContext({
      auth: fakeAuth(CLERK_USER_ID),
      client: fakeClient(null) as never,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: RESOLVE_TENANCY_USER_NOT_LINKED,
      clerkUserId: CLERK_USER_ID,
    });
  });

  it.each([UserStatus.INVITED, UserStatus.SUSPENDED, UserStatus.TERMINATED])(
    "returns USER_NOT_ACTIVE when user.status is %s",
    async (status) => {
      const result = await resolveOperatorTenancyContext({
        auth: fakeAuth(CLERK_USER_ID),
        client: fakeClient({
          id: USER_ID,
          organizationId: ORG_ID,
          email: "owner@acme.test",
          displayName: "Acme Owner",
          status,
          clerkUserId: CLERK_USER_ID,
        }) as never,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: RESOLVE_TENANCY_USER_NOT_ACTIVE,
      });
    }
  );
});

describe("resolveOperatorTenancyContext — cross-request cache", () => {
  const ACTIVE_ROW = {
    id: USER_ID,
    organizationId: ORG_ID,
    email: "owner@acme.test",
    displayName: "Acme Owner",
    status: UserStatus.ACTIVE,
    clerkUserId: CLERK_USER_ID,
  };

  // A client whose `findUnique` spy is exposed so we can assert how many
  // times the authoritative DB lookup actually ran.
  function countingClient(user: typeof ACTIVE_ROW | null) {
    const findUnique = vi.fn(async () => user);
    const userDelegate = { findUnique };
    return {
      findUnique,
      client: {
        user: userDelegate,
        $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
          fn({ $executeRaw: vi.fn(async () => 0), user: userDelegate })
        ),
      },
    };
  }

  it("caches the resolved row and skips the DB on the second call", async () => {
    const cache = memoryCache();
    const { client, findUnique } = countingClient(ACTIVE_ROW);
    const auth = fakeAuth(CLERK_USER_ID);

    const first = await resolveOperatorTenancyContext({ auth, client: client as never, cache });
    expect(first.ok).toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(cache.store.has(operatorIdentityCacheKey(CLERK_USER_ID))).toBe(true);

    const second = await resolveOperatorTenancyContext({ auth, client: client as never, cache });
    expect(second.ok).toBe(true);
    // Served from cache — no second DB read.
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("never negatively caches a not-linked result", async () => {
    const cache = memoryCache();
    const { client, findUnique } = countingClient(null);
    const auth = fakeAuth(CLERK_USER_ID);

    const r1 = await resolveOperatorTenancyContext({ auth, client: client as never, cache });
    const r2 = await resolveOperatorTenancyContext({ auth, client: client as never, cache });

    expect(r1).toMatchObject({ ok: false, reason: RESOLVE_TENANCY_USER_NOT_LINKED });
    expect(r2).toMatchObject({ ok: false, reason: RESOLVE_TENANCY_USER_NOT_LINKED });
    // Re-resolved both times; the null was never cached.
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(cache.store.size).toBe(0);
  });

  it("serves a pre-seeded cache hit without touching the DB", async () => {
    const cache = memoryCache();
    cache.store.set(operatorIdentityCacheKey(CLERK_USER_ID), ACTIVE_ROW);
    // The client would resolve to "not linked" if it were consulted.
    const { client, findUnique } = countingClient(null);

    const result = await resolveOperatorTenancyContext({
      auth: fakeAuth(CLERK_USER_ID),
      client: client as never,
      cache,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operator.userId).toBe(USER_ID);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
