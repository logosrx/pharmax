// Prisma extension contract tests.
//
// We don't spin up a real Prisma client here — that would require
// a database and would couple this package's tests to the schema.
// Instead we simulate Prisma's `$extends` callback shape with a
// minimal fake. The contract we're verifying is "given (model,
// operation, args, ALS state), what args does the extension forward
// to the underlying query?" which is exactly what the fake captures.

import { describe, expect, it } from "vitest";

import { withSystemContext, withTenancyContext } from "./als.js";
import { buildTenancyContext, type TenancyContext } from "./context.js";
import { applyTenancyExtension } from "./prisma-extension.js";

// Minimal shape used by `applyTenancyExtension`. Cast to PrismaClient
// inside the helper; the production code never touches anything
// outside `.$extends({...})`.

type CapturedCall = {
  model: string | undefined;
  operation: string;
  forwardedArgs: Record<string, unknown> | undefined;
};

function makeFakeClient(): {
  client: ReturnType<typeof applyTenancyExtension>;
  calls: CapturedCall[];
  // Drive the extension as if Prisma called it.
  simulate: (
    model: string | undefined,
    operation: string,
    args: Record<string, unknown> | undefined
  ) => Promise<unknown>;
} {
  const calls: CapturedCall[] = [];
  let handler:
    | ((ctx: {
        model: string | undefined;
        operation: string;
        args: Record<string, unknown> | undefined;
        query: (args: Record<string, unknown> | undefined) => Promise<unknown>;
      }) => Promise<unknown>)
    | undefined;

  const fakeClient = {
    $extends(arg: {
      query?: {
        $allModels?: {
          $allOperations?: (ctx: {
            model: string | undefined;
            operation: string;
            args: Record<string, unknown> | undefined;
            query: (args: Record<string, unknown> | undefined) => Promise<unknown>;
          }) => Promise<unknown>;
        };
      };
    }) {
      handler = arg.query?.$allModels?.$allOperations;
      return fakeClient;
    },
  };

  const simulate = async (
    model: string | undefined,
    operation: string,
    args: Record<string, unknown> | undefined
  ): Promise<unknown> => {
    if (handler === undefined) {
      throw new Error("Extension handler not attached.");
    }
    return handler({
      model,
      operation,
      args,
      query: async (forwardedArgs) => {
        calls.push({ model, operation, forwardedArgs });
        return { ok: true };
      },
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extended = applyTenancyExtension(fakeClient as any);
  return { client: extended, calls, simulate };
}

function ctxFor(orgId: string): TenancyContext {
  return buildTenancyContext({
    organizationId: orgId,
    actor: { userId: "user-1", correlationId: "01ULID000000000000000000000" },
  });
}

describe("applyTenancyExtension — pass-through for non-tenant models", () => {
  it("forwards untouched args for Permission (system model)", async () => {
    const { calls, simulate } = makeFakeClient();
    await simulate("Permission", "findMany", { where: { code: "billing.read" } });
    expect(calls[0]?.forwardedArgs).toEqual({ where: { code: "billing.read" } });
  });

  it("forwards untouched args for StripeWebhookEvent (pre-tenancy)", async () => {
    const { calls, simulate } = makeFakeClient();
    await simulate("StripeWebhookEvent", "create", {
      data: { stripeEventId: "evt_1", payload: {} },
    });
    expect(calls[0]?.forwardedArgs).toEqual({
      data: { stripeEventId: "evt_1", payload: {} },
    });
  });
});

describe("applyTenancyExtension — no context active", () => {
  it("throws TENANCY_NO_CONTEXT for tenant-scoped models", async () => {
    const { simulate } = makeFakeClient();
    await expect(simulate("Clinic", "findMany", {})).rejects.toMatchObject({
      code: "TENANCY_NO_CONTEXT",
    });
  });

  it("error names the model and operation", async () => {
    const { simulate } = makeFakeClient();
    await expect(simulate("AuditLog", "create", { data: {} })).rejects.toMatchObject({
      code: "TENANCY_NO_CONTEXT",
      metadata: { model: "AuditLog", operation: "create" },
    });
  });

  it("still passes through non-tenant models", async () => {
    const { calls, simulate } = makeFakeClient();
    await simulate("RolePermission", "findMany", {});
    expect(calls).toHaveLength(1);
  });
});

describe("applyTenancyExtension — system bypass", () => {
  it("passes tenant-scoped queries through unmodified inside withSystemContext", async () => {
    const { calls, simulate } = makeFakeClient();
    await withSystemContext("worker-drain", async () => {
      await simulate("EventOutbox", "findMany", { where: { status: "PENDING" } });
    });
    expect(calls[0]?.forwardedArgs).toEqual({ where: { status: "PENDING" } });
  });
});

describe("applyTenancyExtension — user context filter injection", () => {
  it("merges organizationId into findMany where", async () => {
    const { calls, simulate } = makeFakeClient();
    await withTenancyContext(ctxFor("org-1"), async () => {
      await simulate("Clinic", "findMany", { where: { status: "ACTIVE" } });
    });
    expect(calls[0]?.forwardedArgs).toEqual({
      where: { status: "ACTIVE", organizationId: "org-1" },
    });
  });

  it("merges organizationId into findUnique where (no longer leaks across orgs)", async () => {
    const { calls, simulate } = makeFakeClient();
    await withTenancyContext(ctxFor("org-1"), async () => {
      await simulate("Clinic", "findUnique", { where: { id: "guessed-uuid" } });
    });
    expect(calls[0]?.forwardedArgs).toEqual({
      where: { id: "guessed-uuid", organizationId: "org-1" },
    });
  });

  it("uses {id} for Organization model (self-org filter)", async () => {
    const { calls, simulate } = makeFakeClient();
    await withTenancyContext(ctxFor("org-1"), async () => {
      await simulate("Organization", "findUnique", { where: { id: "org-1" } });
    });
    expect(calls[0]?.forwardedArgs).toEqual({ where: { id: "org-1" } });
  });

  it("injects organizationId into data on create when omitted", async () => {
    const { calls, simulate } = makeFakeClient();
    await withTenancyContext(ctxFor("org-1"), async () => {
      await simulate("Clinic", "create", { data: { name: "Test Clinic" } });
    });
    expect(calls[0]?.forwardedArgs).toEqual({
      data: { name: "Test Clinic", organizationId: "org-1" },
    });
  });

  it("allows create when data.organizationId matches active context", async () => {
    const { calls, simulate } = makeFakeClient();
    await withTenancyContext(ctxFor("org-1"), async () => {
      await simulate("Clinic", "create", {
        data: { name: "Test", organizationId: "org-1" },
      });
    });
    expect(calls[0]?.forwardedArgs).toEqual({
      data: { name: "Test", organizationId: "org-1" },
    });
  });

  it("throws TENANCY_CROSS_ORG_WRITE on mismatched create.data.organizationId", async () => {
    const { simulate } = makeFakeClient();
    await withTenancyContext(ctxFor("org-1"), async () => {
      await expect(
        simulate("Clinic", "create", { data: { name: "Test", organizationId: "org-2" } })
      ).rejects.toMatchObject({
        code: "TENANCY_CROSS_ORG_WRITE",
        metadata: { activeOrganizationId: "org-1", attemptedOrganizationId: "org-2" },
      });
    });
  });

  it("createMany injects org id into every row", async () => {
    const { calls, simulate } = makeFakeClient();
    await withTenancyContext(ctxFor("org-1"), async () => {
      await simulate("AuditLog", "createMany", {
        data: [{ action: "a" }, { action: "b" }],
      });
    });
    expect(calls[0]?.forwardedArgs).toEqual({
      data: [
        { action: "a", organizationId: "org-1" },
        { action: "b", organizationId: "org-1" },
      ],
    });
  });

  it("createMany throws if any row has a mismatched org id", async () => {
    const { simulate } = makeFakeClient();
    await withTenancyContext(ctxFor("org-1"), async () => {
      await expect(
        simulate("AuditLog", "createMany", {
          data: [
            { action: "a", organizationId: "org-1" },
            { action: "b", organizationId: "org-2" },
          ],
        })
      ).rejects.toMatchObject({ code: "TENANCY_CROSS_ORG_WRITE" });
    });
  });

  it("update/delete merge org id into where", async () => {
    const { calls, simulate } = makeFakeClient();
    await withTenancyContext(ctxFor("org-1"), async () => {
      await simulate("Clinic", "update", {
        where: { id: "c1" },
        data: { name: "Renamed" },
      });
      await simulate("Clinic", "delete", { where: { id: "c1" } });
    });
    expect(calls[0]?.forwardedArgs).toEqual({
      where: { id: "c1", organizationId: "org-1" },
      data: { name: "Renamed" },
    });
    expect(calls[1]?.forwardedArgs).toEqual({
      where: { id: "c1", organizationId: "org-1" },
    });
  });

  it("upsert merges org id into where AND injects into create branch", async () => {
    const { calls, simulate } = makeFakeClient();
    await withTenancyContext(ctxFor("org-1"), async () => {
      await simulate("Clinic", "upsert", {
        where: { id: "c1" },
        create: { name: "New" },
        update: { name: "Updated" },
      });
    });
    expect(calls[0]?.forwardedArgs).toEqual({
      where: { id: "c1", organizationId: "org-1" },
      create: { name: "New", organizationId: "org-1" },
      update: { name: "Updated" },
    });
  });

  it("does not mutate the caller's args object", async () => {
    const { simulate } = makeFakeClient();
    const originalArgs = { where: { status: "ACTIVE" } };
    await withTenancyContext(ctxFor("org-1"), async () => {
      await simulate("Clinic", "findMany", originalArgs);
    });
    expect(originalArgs).toEqual({ where: { status: "ACTIVE" } });
  });
});

describe("applyTenancyExtension — cross-tenant isolation property", () => {
  // The defining safety claim: two parallel user contexts cannot
  // see each other's rows, even if a caller in org-1 guesses an
  // exact UUID belonging to org-2.
  it("queries originating in org-A only see org-A filters", async () => {
    const { calls, simulate } = makeFakeClient();

    await Promise.all([
      withTenancyContext(ctxFor("org-A"), async () => {
        await simulate("Clinic", "findUnique", { where: { id: "shared-uuid" } });
      }),
      withTenancyContext(ctxFor("org-B"), async () => {
        await simulate("Clinic", "findUnique", { where: { id: "shared-uuid" } });
      }),
    ]);

    const orgsInForwardedFilters = calls
      .map((c) => (c.forwardedArgs?.["where"] as Record<string, unknown>)?.["organizationId"])
      .sort();
    expect(orgsInForwardedFilters).toEqual(["org-A", "org-B"]);
  });
});
