// Contract tests for the operator-tenancy resolver.
//
// Drives the resolver with injected stubs for both Clerk's `auth()`
// and the Pharmax Prisma client surface — no actual Clerk SDK calls,
// no DB roundtrip.

import { UserStatus } from "@pharmax/database";
import { describe, expect, it, vi } from "vitest";

import {
  RESOLVE_TENANCY_NO_SESSION,
  RESOLVE_TENANCY_USER_NOT_ACTIVE,
  RESOLVE_TENANCY_USER_NOT_LINKED,
  resolveOperatorTenancyContext,
} from "./resolve-tenancy.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const CLERK_USER_ID = "user_2abcXYZ";

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
  return {
    user: {
      findUnique: vi.fn(async () => user),
    },
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
