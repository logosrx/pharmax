// Tests for the operator-permission cache: key, (de)serialization,
// invalidation, and the cross-request caching loader decorator.

import { NoopCache, type Cache } from "@pharmax/composition";
import type { RoleScope } from "@pharmax/database";
import type { EffectivePermissionLoader, PermissionCode, ResolvedGrant } from "@pharmax/rbac";
import { describe, expect, it, vi } from "vitest";

import {
  CachedPermissionLoader,
  deserializeGrants,
  invalidateOperatorPermissionCache,
  operatorPermissionCacheKey,
  serializeGrants,
} from "./operator-permission-cache.js";

const ORG_ID = "11111111-1111-7111-a111-111111111111";
const USER_ID = "22222222-2222-7222-a222-222222222222";

function grant(): ResolvedGrant {
  return {
    roleScope: "ORG" as unknown as RoleScope,
    grantScope: { siteId: null, clinicId: null, teamId: "team-1" },
    permissions: new Set(["typing.start", "pv1.start"] as unknown as PermissionCode[]),
  };
}

/** Stateful fake cache that round-trips values through JSON (like Redis). */
function mapCache(): Cache {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => {
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    }),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, JSON.stringify(value));
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    deletePrefix: vi.fn(async () => {}),
  };
}

function fakeCache(overrides: Partial<Cache> = {}): Cache {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    deletePrefix: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("operatorPermissionCacheKey", () => {
  it("is namespaced + versioned with org and user", () => {
    expect(operatorPermissionCacheKey(ORG_ID, USER_ID)).toBe(
      `operator-permissions:v1:${ORG_ID}:${USER_ID}`
    );
  });
});

describe("serializeGrants / deserializeGrants", () => {
  it("round-trips grants including the permission Set", () => {
    const round = deserializeGrants(serializeGrants([grant()]));
    expect(round).toHaveLength(1);
    expect(round[0]?.roleScope).toBe("ORG");
    expect(round[0]?.grantScope).toEqual({ siteId: null, clinicId: null, teamId: "team-1" });
    expect(round[0]?.permissions).toBeInstanceOf(Set);
    expect([...round[0]!.permissions].sort()).toEqual(["pv1.start", "typing.start"]);
  });

  it("survives a JSON round trip (cache transport fidelity)", () => {
    const serialized = serializeGrants([grant()]);
    const viaJson = JSON.parse(JSON.stringify(serialized));
    const round = deserializeGrants(viaJson);
    expect([...round[0]!.permissions].sort()).toEqual(["pv1.start", "typing.start"]);
  });
});

describe("invalidateOperatorPermissionCache", () => {
  it("deletes the namespaced key", async () => {
    const cache = fakeCache();
    await invalidateOperatorPermissionCache(ORG_ID, USER_ID, { cache });
    expect(cache.delete).toHaveBeenCalledWith(`operator-permissions:v1:${ORG_ID}:${USER_ID}`);
  });

  it("swallows transport errors (TTL is the safety net)", async () => {
    const cache = fakeCache({
      delete: vi.fn(async () => {
        throw new Error("redis down");
      }),
    });
    await expect(
      invalidateOperatorPermissionCache(ORG_ID, USER_ID, { cache })
    ).resolves.toBeUndefined();
  });
});

describe("CachedPermissionLoader", () => {
  it("loads once on a cache hit and returns the same grants", async () => {
    const inner: EffectivePermissionLoader = { load: vi.fn(async () => [grant()]) };
    const loader = new CachedPermissionLoader(inner, mapCache());

    const first = await loader.load({ organizationId: ORG_ID, userId: USER_ID });
    const second = await loader.load({ organizationId: ORG_ID, userId: USER_ID });

    expect(inner.load).toHaveBeenCalledTimes(1); // second served from cache
    expect([...second[0]!.permissions].sort()).toEqual(["pv1.start", "typing.start"]);
    expect(first[0]?.grantScope).toEqual(second[0]?.grantScope);
  });

  it("falls through to the inner loader on every call with a NoopCache", async () => {
    const inner: EffectivePermissionLoader = { load: vi.fn(async () => [grant()]) };
    const loader = new CachedPermissionLoader(inner, new NoopCache());

    await loader.load({ organizationId: ORG_ID, userId: USER_ID });
    await loader.load({ organizationId: ORG_ID, userId: USER_ID });

    expect(inner.load).toHaveBeenCalledTimes(2);
  });

  it("degrades to the inner loader when the cache get throws", async () => {
    const inner: EffectivePermissionLoader = { load: vi.fn(async () => [grant()]) };
    const cache = fakeCache({
      get: vi.fn(async () => {
        throw new Error("redis down");
      }),
    });
    const loader = new CachedPermissionLoader(inner, cache);

    const result = await loader.load({ organizationId: ORG_ID, userId: USER_ID });
    expect(result).toHaveLength(1);
    expect(inner.load).toHaveBeenCalledTimes(1);
  });
});
