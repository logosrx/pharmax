// withSentryOpsScope contract tests.
//
// We mock `@sentry/nextjs`'s `withScope` so the test runs without
// a real Sentry SDK. Assertions:
//   - `withScope` is called and the callback's return value is
//     propagated.
//   - The scope receives `setUser` with the operator id (and the
//     displayName as `username` when provided).
//   - `organizationId` lands as a tag.
//   - Optional bindings (commandName, route, surface, clerkUserId)
//     only get set when provided — absent ones don't pollute the
//     scope.
//   - Errors thrown by the inner fn propagate up unchanged so
//     existing catch logic continues to produce flash errors.

import { afterEach, describe, expect, it, vi } from "vitest";

interface ScopeRecord {
  user: Record<string, unknown> | null;
  tags: Map<string, string>;
  contexts: Map<string, Record<string, unknown> | null>;
}

function freshScope(): ScopeRecord {
  return { user: null, tags: new Map(), contexts: new Map() };
}

const scope: ScopeRecord = freshScope();

vi.mock("@sentry/nextjs", () => ({
  withScope: <T>(
    fn: (s: {
      setUser: (u: Record<string, unknown>) => void;
      setTag: (k: string, v: string) => void;
      setContext: (k: string, v: Record<string, unknown> | null) => void;
    }) => Promise<T> | T
  ): Promise<T> | T => {
    return fn({
      setUser: (u) => {
        scope.user = u;
      },
      setTag: (k, v) => {
        scope.tags.set(k, v);
      },
      setContext: (k, v) => {
        scope.contexts.set(k, v);
      },
    });
  },
}));

const { withSentryOpsScope } = await import("./ops-scope.js");

afterEach(() => {
  scope.user = null;
  scope.tags.clear();
  scope.contexts.clear();
});

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000009";

describe("withSentryOpsScope — happy path", () => {
  it("sets user + organization tag and propagates the callback return value", async () => {
    const out = await withSentryOpsScope(
      { operatorUserId: USER_ID, organizationId: ORG_ID },
      async () => "result"
    );
    expect(out).toBe("result");
    expect(scope.user).toEqual({ id: USER_ID });
    expect(scope.tags.get("organizationId")).toBe(ORG_ID);
  });

  it("includes displayName as username when provided", async () => {
    await withSentryOpsScope(
      {
        operatorUserId: USER_ID,
        organizationId: ORG_ID,
        operatorDisplayName: "Pat Operator",
      },
      async () => undefined
    );
    expect(scope.user).toEqual({ id: USER_ID, username: "Pat Operator" });
  });

  it("sets commandName, route, surface tags when provided", async () => {
    await withSentryOpsScope(
      {
        operatorUserId: USER_ID,
        organizationId: ORG_ID,
        commandName: "ApprovePV1",
        route: "route:approve-pv1:order-1",
        surface: "ORDER_DETAIL_PAGE",
      },
      async () => undefined
    );
    expect(scope.tags.get("commandName")).toBe("ApprovePV1");
    expect(scope.tags.get("route")).toBe("route:approve-pv1:order-1");
    expect(scope.tags.get("surface")).toBe("ORDER_DETAIL_PAGE");
  });

  it("does not set optional tags when absent", async () => {
    await withSentryOpsScope(
      { operatorUserId: USER_ID, organizationId: ORG_ID },
      async () => undefined
    );
    expect(scope.tags.has("commandName")).toBe(false);
    expect(scope.tags.has("route")).toBe(false);
    expect(scope.tags.has("surface")).toBe(false);
  });

  it("sets operator context with clerkUserId when provided", async () => {
    await withSentryOpsScope(
      {
        operatorUserId: USER_ID,
        organizationId: ORG_ID,
        operatorDisplayName: "Pat",
        clerkUserId: "user_clerk_abc",
      },
      async () => undefined
    );
    expect(scope.contexts.get("operator")).toEqual({
      userId: USER_ID,
      organizationId: ORG_ID,
      displayName: "Pat",
      clerkUserId: "user_clerk_abc",
    });
  });
});

describe("withSentryOpsScope — error propagation", () => {
  it("re-throws errors from the inner callback unchanged", async () => {
    const boom = new Error("inner failure");
    await expect(
      withSentryOpsScope({ operatorUserId: USER_ID, organizationId: ORG_ID }, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });
});
