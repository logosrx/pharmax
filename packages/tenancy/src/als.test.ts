// AsyncLocalStorage propagation contract.
//
// These tests pin the behavior the entire isolation story rests on.
// If any of them ever fail in the future, the Prisma extension's
// safety claims fail too, and we should NOT relax the assertion —
// we should find what broke ALS propagation and fix it.

import { describe, expect, it } from "vitest";

import {
  describeCurrentContext,
  getCurrentContext,
  getSystemContextReason,
  isSystemContext,
  requireCurrentContext,
  withSystemContext,
  withTenancyContext,
} from "./als.js";
import { buildTenancyContext, type TenancyContext } from "./context.js";

function fixtureCtx(overrides?: Partial<TenancyContext>): TenancyContext {
  return buildTenancyContext({
    organizationId: "org-fixture-001",
    actor: { userId: "user-fixture-001", correlationId: "01ULID000000000000000000000" },
    ...overrides,
  });
}

describe("AsyncLocalStorage tenancy context", () => {
  it("describeCurrentContext returns 'none' when no frame is active", () => {
    expect(describeCurrentContext()).toBe("none");
    expect(getCurrentContext()).toBeNull();
    expect(isSystemContext()).toBe(false);
    expect(getSystemContextReason()).toBeNull();
  });

  it("requireCurrentContext throws with TENANCY_NO_CONTEXT when no frame is active", () => {
    expect(() => requireCurrentContext()).toThrow(
      expect.objectContaining({ code: "TENANCY_NO_CONTEXT" })
    );
  });

  it("withTenancyContext exposes the context to sync callers", async () => {
    const ctx = fixtureCtx();
    await withTenancyContext(ctx, () => {
      expect(describeCurrentContext()).toBe("user");
      expect(getCurrentContext()).toBe(ctx);
      expect(isSystemContext()).toBe(false);
    });
  });

  it("withTenancyContext propagates across await boundaries", async () => {
    const ctx = fixtureCtx();
    await withTenancyContext(ctx, async () => {
      await Promise.resolve();
      expect(getCurrentContext()).toBe(ctx);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(getCurrentContext()).toBe(ctx);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getCurrentContext()).toBe(ctx);
    });
  });

  it("withTenancyContext propagates through Promise.all", async () => {
    const ctx = fixtureCtx();
    await withTenancyContext(ctx, async () => {
      const seen = await Promise.all([
        Promise.resolve().then(() => getCurrentContext()?.organizationId),
        Promise.resolve().then(() => getCurrentContext()?.organizationId),
        Promise.resolve().then(() => getCurrentContext()?.organizationId),
      ]);
      expect(seen).toEqual([ctx.organizationId, ctx.organizationId, ctx.organizationId]);
    });
  });

  it("nested withTenancyContext frames shadow the outer frame and restore on exit", async () => {
    const outer = fixtureCtx({ organizationId: "org-outer" });
    const inner = fixtureCtx({ organizationId: "org-inner" });
    await withTenancyContext(outer, async () => {
      expect(getCurrentContext()?.organizationId).toBe("org-outer");
      await withTenancyContext(inner, async () => {
        expect(getCurrentContext()?.organizationId).toBe("org-inner");
      });
      // Restored after inner exits.
      expect(getCurrentContext()?.organizationId).toBe("org-outer");
    });
  });

  it("concurrent withTenancyContext calls remain isolated", async () => {
    const ctxA = fixtureCtx({ organizationId: "org-A" });
    const ctxB = fixtureCtx({ organizationId: "org-B" });

    const run = (ctx: TenancyContext, iterations: number): Promise<string[]> =>
      withTenancyContext(ctx, async () => {
        const seen: string[] = [];
        for (let i = 0; i < iterations; i += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          seen.push(getCurrentContext()?.organizationId ?? "<none>");
        }
        return seen;
      });

    const [a, b] = await Promise.all([run(ctxA, 5), run(ctxB, 5)]);
    expect(a.every((v) => v === "org-A")).toBe(true);
    expect(b.every((v) => v === "org-B")).toBe(true);
  });

  it("withSystemContext does NOT surface a user context but is detected via isSystemContext", async () => {
    await withSystemContext("worker-drain:event-outbox", async () => {
      expect(describeCurrentContext()).toBe("system");
      expect(getCurrentContext()).toBeNull();
      expect(isSystemContext()).toBe(true);
      expect(getSystemContextReason()).toBe("worker-drain:event-outbox");
      expect(() => requireCurrentContext()).toThrow(
        expect.objectContaining({ code: "TENANCY_NO_CONTEXT" })
      );
    });
  });

  it("user context nested inside a system context is treated as user", async () => {
    const userCtx = fixtureCtx();
    await withSystemContext("worker-drain:event-outbox", async () => {
      await withTenancyContext(userCtx, async () => {
        expect(describeCurrentContext()).toBe("user");
        expect(getCurrentContext()).toBe(userCtx);
        expect(isSystemContext()).toBe(false);
      });
      // Restored to system.
      expect(describeCurrentContext()).toBe("system");
    });
  });
});

describe("buildTenancyContext", () => {
  it("freezes the returned context and its nested actor", () => {
    const ctx = buildTenancyContext({
      organizationId: "org-1",
      actor: { userId: "user-1", correlationId: "01ULID000000000000000000000" },
    });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.actor)).toBe(true);
  });
});
