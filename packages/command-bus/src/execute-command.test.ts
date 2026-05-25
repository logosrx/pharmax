// executeCommand contract — the 20-step orchestration.
//
// Every test here asserts both POSITIVE behavior (what was written)
// and NEGATIVE behavior (what was NOT written when a check fails).
// The negative assertions are the SOC 2-critical ones: a request
// that fails RBAC must leave ZERO database footprint.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { CommandStatus } from "@pharmax/database";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { RoleScope } from "@pharmax/database";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { configureCommandBus, resetCommandBusConfigurationForTests } from "./configure.js";
import { executeCommand } from "./execute-command.js";
import { hashRequest } from "./hash.js";
import type { Command, HandlerResult } from "./types.js";
import { buildFakeConfig, buildFakePrisma, callsTo, type FakePrisma } from "./test-helpers.js";

const orgWideAdminGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.ORDERS_CREATE,
      PERMISSIONS.PV1_APPROVE,
    ]),
  },
];

function ctxFor(overrides: Record<string, unknown> = {}): TenancyContext {
  const base: Record<string, unknown> = {
    organizationId: "org-1",
    actor: { userId: "user-1", correlationId: "01CORRELATION0000000000000" },
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return buildTenancyContext(base as unknown as Parameters<typeof buildTenancyContext>[0]);
}

const sampleSchema = z.object({ orderId: z.string().uuid(), note: z.string().optional() });
type SampleInput = z.infer<typeof sampleSchema>;
interface SampleOutput {
  readonly accepted: boolean;
}

function sampleCommand(
  overrides: Partial<Command<SampleInput, SampleOutput>> = {}
): Command<SampleInput, SampleOutput> {
  return {
    name: "SampleCommand",
    inputSchema: sampleSchema,
    permission: PERMISSIONS.ORDERS_CREATE,
    async handle({ input, ctx, commandLogId }): Promise<HandlerResult<SampleOutput>> {
      return {
        output: { accepted: true },
        audit: {
          action: "sample.executed",
          resourceType: "Order",
          resourceId: input.orderId,
          metadata: { note: input.note ?? null },
        },
        outboxEvents: [
          {
            eventType: "sample.executed.v1",
            aggregateType: "Order",
            aggregateId: input.orderId,
            payload: { orderId: input.orderId, organizationId: ctx.organizationId, commandLogId },
          },
        ],
        targetOrderId: input.orderId,
      };
    },
    ...overrides,
  };
}

let prisma: FakePrisma;

beforeEach(() => {
  prisma = buildFakePrisma();
  configureCommandBus(buildFakeConfig(prisma));
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: "org-1", userId: "user-1", grants: orgWideAdminGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

describe("executeCommand — happy path", () => {
  it("writes command_log (PRE-TX, RUNNING) → tx open → audit + outbox + idempotency in tx → command_log SUCCEEDED", async () => {
    const cmd = sampleCommand();
    const orderId = "11111111-1111-7111-a111-111111111111";
    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId, note: "ok" }, { idempotencyKey: "key-1" })
    );

    expect(out).toEqual({ accepted: true });

    const cmdLogCreates = callsTo(prisma, "commandLog", "create");
    expect(cmdLogCreates).toHaveLength(1);
    expect(cmdLogCreates[0]?.args).toMatchObject({
      data: expect.objectContaining({
        organizationId: "org-1",
        commandName: "SampleCommand",
        idempotencyKey: "key-1",
        status: CommandStatus.RUNNING,
        actorUserId: "user-1",
      }),
    });

    expect(prisma.client.$transaction).toHaveBeenCalledOnce();

    // Step 8a — RLS session GUCs MUST be set inside the tx BEFORE
    // any audit/outbox write. We assert (a) the calls happened, and
    // (b) they appear in the call log BEFORE the auditLog create.
    const gucCalls = callsTo(prisma, "$executeRaw", "set_config");
    expect(gucCalls.length).toBeGreaterThanOrEqual(2);
    const firstGucIdx = prisma.calls.indexOf(gucCalls[0]!);
    const firstAuditIdx = prisma.calls.indexOf(callsTo(prisma, "auditLog", "create")[0]!);
    expect(firstGucIdx).toBeLessThan(firstAuditIdx);
    // The tenancy GUC carries the active organizationId as a bound
    // parameter (NOT interpolated into the SQL text).
    const gucValues = gucCalls.flatMap(
      (c) => (c.args as { values: ReadonlyArray<unknown> }).values
    );
    expect(gucValues).toContain("org-1");

    // Step 8b — the audit chain writer acquires a per-tenant advisory
    // lock via `pg_advisory_xact_lock(audit_chain_lock_key($1))`
    // BEFORE inserting audit_log. The lock must appear AFTER the
    // tenancy GUC (so RLS is already constrained) and BEFORE the
    // audit_log create (so concurrent chain writers serialize).
    const lockCalls = callsTo(prisma, "$executeRaw", "advisory_lock");
    expect(lockCalls).toHaveLength(1);
    const firstLockIdx = prisma.calls.indexOf(lockCalls[0]!);
    expect(firstLockIdx).toBeGreaterThan(firstGucIdx);
    expect(firstLockIdx).toBeLessThan(firstAuditIdx);
    // The lock key is derived from the organizationId — passed as a
    // bound parameter, not interpolated into the SQL text.
    expect((lockCalls[0]?.args as { values: ReadonlyArray<unknown> }).values).toContain("org-1");

    expect(callsTo(prisma, "auditLog", "create")).toHaveLength(1);
    const auditCreateArgs = callsTo(prisma, "auditLog", "create")[0]?.args as {
      data: Record<string, unknown>;
    };
    expect(auditCreateArgs).toMatchObject({
      data: expect.objectContaining({
        organizationId: "org-1",
        action: "sample.executed",
        resourceType: "Order",
        resourceId: orderId,
      }),
    });
    // Chain columns: genesis insert → seq=1, prevHash=null, 32-byte hash.
    expect(auditCreateArgs.data["seq"]).toBe(1n);
    expect(auditCreateArgs.data["prevHash"]).toBeNull();
    expect(auditCreateArgs.data["entryHash"]).toBeInstanceOf(Buffer);
    expect((auditCreateArgs.data["entryHash"] as Buffer).length).toBe(32);

    // The audit chain writer also upserts audit_chain_state with the
    // new tip hash and seq. Without this call, a subsequent insert
    // would re-genesis the chain. (The advisory lock + this upsert
    // are what make the chain race-free.)
    const chainUpserts = callsTo(prisma, "auditChainState", "upsert");
    expect(chainUpserts).toHaveLength(1);

    expect(callsTo(prisma, "eventOutbox", "createMany")).toHaveLength(1);

    expect(callsTo(prisma, "idempotencyKey", "create")).toHaveLength(1);
    expect(callsTo(prisma, "idempotencyKey", "create")[0]?.args).toMatchObject({
      data: expect.objectContaining({
        organizationId: "org-1",
        commandName: "SampleCommand",
        key: "key-1",
      }),
    });

    const cmdLogUpdates = callsTo(prisma, "commandLog", "update");
    expect(cmdLogUpdates).toHaveLength(1);
    expect(cmdLogUpdates[0]?.args).toMatchObject({
      data: expect.objectContaining({ status: CommandStatus.SUCCEEDED }),
    });
  });
});

describe("executeCommand — gate failures leave NO DB footprint", () => {
  it("Zod validation failure → ValidationError, no command_log row", async () => {
    const cmd = sampleCommand();
    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(cmd, { orderId: "not-a-uuid" }, { idempotencyKey: "k" })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
    expect(prisma.client.$transaction).not.toHaveBeenCalled();
  });

  it("no tenancy context → TENANCY_NO_CONTEXT, no command_log row", async () => {
    const cmd = sampleCommand();
    await expect(
      executeCommand(cmd, { orderId: "11111111-1111-7111-a111-111111111111" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
  });

  it("RBAC denial → PERMISSION_DENIED, no command_log row", async () => {
    const cmd = sampleCommand({ permission: PERMISSIONS.BILLING_MANAGE });
    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          cmd,
          { orderId: "11111111-1111-7111-a111-111111111111" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
  });

  it("workstation required but missing → COMMAND_WORKSTATION_REQUIRED, no command_log row", async () => {
    const cmd = sampleCommand({ requiresWorkstation: true });
    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          cmd,
          { orderId: "11111111-1111-7111-a111-111111111111" },
          { idempotencyKey: "k" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_WORKSTATION_REQUIRED" });
    });
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
  });

  it("workstation required AND present → succeeds", async () => {
    const cmd = sampleCommand({ requiresWorkstation: true });
    await withTenancyContext(ctxFor({ workstationId: "ws-1" }), async () => {
      const out = await executeCommand(
        cmd,
        { orderId: "11111111-1111-7111-a111-111111111111" },
        { idempotencyKey: "k" }
      );
      expect(out).toEqual({ accepted: true });
    });
  });
});

describe("executeCommand — idempotency", () => {
  it("replay hit (matching request hash) returns cached response, handler NOT re-run", async () => {
    const cachedResponse = { accepted: false };
    const orderId = "22222222-2222-7222-a222-222222222222";
    const input = { orderId };

    // Pre-populate the idempotency cache with the same payload's
    // hash. Note redactPayload runs on top-level objects, so the
    // hash is over the redacted payload.
    const redacted = { orderId };
    prisma.setIdempotencyHit({
      requestHash: hashRequest(redacted),
      responsePayload: cachedResponse,
      responseStatus: null,
    });

    let handlerCalls = 0;
    const cmd = sampleCommand({
      handle: async ({ input: i }) => {
        handlerCalls += 1;
        return {
          output: { accepted: true },
          audit: { action: "sample.x", resourceType: "Order", resourceId: i.orderId },
          outboxEvents: [],
        };
      },
    });

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, input, { idempotencyKey: "replay-key" })
    );
    expect(out).toEqual(cachedResponse);
    expect(handlerCalls).toBe(0);
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
    expect(prisma.client.$transaction).not.toHaveBeenCalled();
  });

  it("replay collision (same key, different payload) → ConflictError", async () => {
    prisma.setIdempotencyHit({
      requestHash: "0".repeat(64),
      responsePayload: { accepted: false },
      responseStatus: null,
    });

    const cmd = sampleCommand();
    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          cmd,
          { orderId: "33333333-3333-7333-a333-333333333333" },
          { idempotencyKey: "collision-key" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH" });
    });
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
  });
});

describe("executeCommand — handler failure path", () => {
  it("handler throws → command_log marked FAILED, NO audit/outbox/idempotency rows", async () => {
    const cmd = sampleCommand({
      handle: async () => {
        throw new Error("domain boom");
      },
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          cmd,
          { orderId: "44444444-4444-7444-a444-444444444444" },
          { idempotencyKey: "fail-key" }
        )
      ).rejects.toThrow(/domain boom/);
    });

    // The pre-tx command_log create still happened (status RUNNING).
    expect(callsTo(prisma, "commandLog", "create")).toHaveLength(1);
    // The bus marked it FAILED via update.
    const updates = callsTo(prisma, "commandLog", "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args).toMatchObject({
      data: expect.objectContaining({ status: CommandStatus.FAILED }),
    });

    // The tx is rolled back by Prisma after throw — our fake tx
    // does not actually persist anything, but the bus's contract
    // is that audit/outbox/idempotency rows live INSIDE the tx, so
    // a rollback discards them. We assert no UPDATE was issued
    // outside the tx for those tables (they only have create
    // inside-tx writes recorded; the rollback is Prisma's job).
    const auditCalls = callsTo(prisma, "auditLog", "create");
    const outboxCalls = callsTo(prisma, "eventOutbox", "createMany");
    const idemCalls = callsTo(prisma, "idempotencyKey", "create");
    // These calls WERE made (inside the tx) BEFORE the throw —
    // but since the handler is the FIRST thing in the tx, and our
    // sample throws immediately, none of the bus-side in-tx writes
    // get a chance to run. So 0 of each.
    expect(auditCalls).toHaveLength(0);
    expect(outboxCalls).toHaveLength(0);
    expect(idemCalls).toHaveLength(0);
  });
});

describe("executeCommand — redaction", () => {
  it("redacts declared fields before writing requestPayload", async () => {
    const redactingSchema = z.object({
      orderId: z.string().uuid(),
      secret: z.string().optional(),
    });
    type RedactingInput = z.infer<typeof redactingSchema>;
    const cmd: Command<RedactingInput, SampleOutput> = {
      name: "RedactingCommand",
      inputSchema: redactingSchema,
      permission: PERMISSIONS.ORDERS_CREATE,
      redactFields: ["secret"],
      async handle({ input }) {
        return {
          output: { accepted: true },
          audit: { action: "x", resourceType: "Order", resourceId: input.orderId },
          outboxEvents: [],
        };
      },
    };
    await withTenancyContext(ctxFor(), () =>
      executeCommand(
        cmd,
        { orderId: "55555555-5555-7555-a555-555555555555", secret: "hunter2" },
        { idempotencyKey: "redact-key" }
      )
    );

    const create = callsTo(prisma, "commandLog", "create")[0]?.args as {
      data: { requestPayload: Record<string, unknown> };
    };
    expect(create.data.requestPayload["secret"]).toBe("[Redacted]");
    expect(create.data.requestPayload["orderId"]).toBe("55555555-5555-7555-a555-555555555555");
  });
});

describe("executeCommand — generates idempotency key when omitted", () => {
  it("uses a ULID when caller omits idempotencyKey", async () => {
    const cmd = sampleCommand();
    await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId: "66666666-6666-7666-a666-666666666666" })
    );

    const args = callsTo(prisma, "commandLog", "create")[0]?.args as {
      data: { idempotencyKey: string };
    };
    expect(args.data.idempotencyKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
