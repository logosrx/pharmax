// Tests for the operator-identity cache key + invalidation helper.

import type { Cache } from "@pharmax/composition";
import { describe, expect, it, vi } from "vitest";

import {
  invalidateOperatorIdentityCache,
  operatorIdentityCacheKey,
} from "./operator-identity-cache.js";

const CLERK_USER_ID = "user_2abcXYZ";

function fakeCache(overrides: Partial<Cache> = {}): Cache {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    deletePrefix: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("operatorIdentityCacheKey", () => {
  it("is namespaced + versioned", () => {
    expect(operatorIdentityCacheKey(CLERK_USER_ID)).toBe(`operator-identity:v1:${CLERK_USER_ID}`);
  });
});

describe("invalidateOperatorIdentityCache", () => {
  it("deletes the namespaced key for the Clerk userId", async () => {
    const cache = fakeCache();
    await invalidateOperatorIdentityCache(CLERK_USER_ID, { cache });
    expect(cache.delete).toHaveBeenCalledWith(`operator-identity:v1:${CLERK_USER_ID}`);
  });

  it("swallows transport errors (TTL is the safety net)", async () => {
    const cache = fakeCache({
      delete: vi.fn(async () => {
        throw new Error("redis down");
      }),
    });
    await expect(
      invalidateOperatorIdentityCache(CLERK_USER_ID, { cache })
    ).resolves.toBeUndefined();
  });
});
