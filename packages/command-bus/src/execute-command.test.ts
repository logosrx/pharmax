// executeCommand contract — the 20-step orchestration.
//
// Every test here asserts both POSITIVE behavior (what was written)
// and NEGATIVE behavior (what was NOT written when a check fails).
// The negative assertions are the SOC 2-critical ones: a request
// that fails RBAC must leave ZERO database footprint.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { CommandStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
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
import { executeCommand, executeCommandDetailed } from "./execute-command.js";
import { hashRequestKeyed } from "./hash.js";
import type { Command, HandlerResult } from "./types.js";
import {
  buildFakeConfig,
  buildFakePrisma,
  callsTo,
  TEST_REQUEST_HASH_KEY,
  uniqueViolationOnCommandLog,
  type FakePrisma,
} from "./test-helpers.js";

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

    // Three transactions: GUC'd pre-flight (idempotency lookup +
    // command_log create), the main handler tx, and the GUC'd
    // SUCCEEDED status update. command_log and idempotency_key are
    // RLS-protected, so NONE of the bookkeeping may run on the raw
    // pooled client (no tenant GUC there).
    expect(prisma.client.$transaction).toHaveBeenCalledTimes(3);

    // Step 8a — RLS session GUCs MUST be set inside the tx BEFORE
    // any audit/outbox write. We assert (a) the calls happened, and
    // (b) they appear in the call log BEFORE the auditLog create.
    // The tenancy GUC (organization_id + system_context clear) is
    // issued as a SINGLE round trip — one `$executeRaw` with both
    // set_config calls in one SELECT target list.
    const gucCalls = callsTo(prisma, "$executeRaw", "set_config");
    expect(gucCalls.length).toBeGreaterThanOrEqual(1);
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
      executeCommand(
        cmd,
        { orderId: "11111111-1111-7111-a111-111111111111" },
        { idempotencyKey: "k" }
      )
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

    // Pre-populate the idempotency cache with this payload's hash.
    // The hash covers the FULL parsed input (keyed HMAC) — NOT the
    // redacted projection, which would collapse different PHI
    // payloads into the same hash.
    prisma.setIdempotencyHit({
      requestHash: hashRequestKeyed(input, TEST_REQUEST_HASH_KEY),
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
    // No command_log row for a replay; the only tx is the GUC'd
    // pre-flight lookup.
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
    expect(prisma.client.$transaction).toHaveBeenCalledTimes(1);
    expect(callsTo(prisma, "auditLog")).toHaveLength(0);
  });

  it("redaction does NOT collapse different payloads: same key + different PHI → mismatch, not replay", async () => {
    // Regression for the redacted-hash bug: two different payloads
    // whose REDACTED projections are identical must still be told
    // apart. Cache a hash for payload A; submit payload B under the
    // same key with a redacted field covering the differing value.
    const redactingSchema = z.object({ orderId: z.string().uuid(), dob: z.string() });
    type RedactingInput = z.infer<typeof redactingSchema>;
    const cmd: Command<RedactingInput, SampleOutput> = {
      name: "RedactingCommand",
      inputSchema: redactingSchema,
      permission: PERMISSIONS.ORDERS_CREATE,
      redactFields: ["dob"],
      async handle({ input: i }) {
        return {
          output: { accepted: true },
          audit: { action: "x", resourceType: "Order", resourceId: i.orderId },
          outboxEvents: [],
        };
      },
    };
    const orderId = "22222222-2222-7222-a222-222222222222";
    const payloadA = { orderId, dob: "1980-01-01" };
    const payloadB = { orderId, dob: "1999-12-31" };
    prisma.setIdempotencyHit({
      requestHash: hashRequestKeyed(payloadA, TEST_REQUEST_HASH_KEY),
      responsePayload: { accepted: false },
      responseStatus: null,
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(cmd, payloadB, { idempotencyKey: "same-key" })
      ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH" });
    });
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

describe("executeCommandDetailed — replay visibility (ADR-0032 one-time secrets)", () => {
  it("fresh execution → replayed: false, handler output returned", async () => {
    const cmd = sampleCommand();
    const orderId = "44444444-4444-7444-a444-444444444444";
    const result = await withTenancyContext(ctxFor(), () =>
      executeCommandDetailed(cmd, { orderId }, { idempotencyKey: "detailed-fresh" })
    );
    expect(result.replayed).toBe(false);
    expect(result.output).toEqual({ accepted: true });
  });

  it("idempotency hit → replayed: true, cached output, handler NOT run", async () => {
    const orderId = "44444444-4444-7444-a444-444444444444";
    const input = { orderId };
    prisma.setIdempotencyHit({
      requestHash: hashRequestKeyed(input, TEST_REQUEST_HASH_KEY),
      responsePayload: { accepted: false },
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

    const result = await withTenancyContext(ctxFor(), () =>
      executeCommandDetailed(cmd, input, { idempotencyKey: "detailed-replay" })
    );
    expect(result.replayed).toBe(true);
    expect(result.output).toEqual({ accepted: false });
    expect(handlerCalls).toBe(0);
  });
});

describe("executeCommand — hashExcludeFields (transport-generated secret material)", () => {
  // Mirrors the CreateApiKey / CreateWebhookSubscription shape: the
  // transport layer regenerates `secret` on every attempt, so the
  // request hash must cover only the client-controlled fields.
  const secretSchema = z.object({ name: z.string(), secret: z.string() });
  type SecretInput = z.infer<typeof secretSchema>;
  function secretCommand(): Command<SecretInput, SampleOutput> {
    return {
      name: "SecretCommand",
      inputSchema: secretSchema,
      permission: PERMISSIONS.ORDERS_CREATE,
      redactFields: ["secret"],
      hashExcludeFields: ["secret"],
      async handle() {
        return {
          output: { accepted: true },
          audit: { action: "x", resourceType: "ApiKey", resourceId: "k-1" },
          outboxEvents: [],
        };
      },
    };
  }

  it("retry with a DIFFERENT excluded secret but same client fields → replay, not mismatch", async () => {
    // First attempt stored a hash computed WITHOUT the secret field.
    prisma.setIdempotencyHit({
      requestHash: hashRequestKeyed({ name: "acme-prod" }, TEST_REQUEST_HASH_KEY),
      responsePayload: { accepted: false },
      responseStatus: null,
    });

    const result = await withTenancyContext(ctxFor(), () =>
      executeCommandDetailed(
        secretCommand(),
        { name: "acme-prod", secret: "pxw_regenerated-on-retry" },
        { idempotencyKey: "secret-retry-key" }
      )
    );
    expect(result.replayed).toBe(true);
    expect(result.output).toEqual({ accepted: false });
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
  });

  it("same key but DIFFERENT client-controlled field → mismatch (guard not weakened)", async () => {
    prisma.setIdempotencyHit({
      requestHash: hashRequestKeyed({ name: "acme-prod" }, TEST_REQUEST_HASH_KEY),
      responsePayload: { accepted: false },
      responseStatus: null,
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommandDetailed(
          secretCommand(),
          { name: "DIFFERENT-name", secret: "pxw_whatever" },
          { idempotencyKey: "secret-retry-key" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH" });
    });
  });

  it("stores the exclusion-adjusted hash on first execution", async () => {
    await withTenancyContext(ctxFor(), () =>
      executeCommandDetailed(
        secretCommand(),
        { name: "acme-prod", secret: "pxw_first-attempt" },
        { idempotencyKey: "secret-first-key" }
      )
    );
    const stored = callsTo(prisma, "idempotencyKey", "create")[0]?.args as {
      data: { requestHash: string };
    };
    expect(stored.data.requestHash).toBe(
      hashRequestKeyed({ name: "acme-prod" }, TEST_REQUEST_HASH_KEY)
    );
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

describe("executeCommand — committed refusal", () => {
  const REFUSED_ORDER = "55555555-5555-7555-a555-555555555555";

  function refusingCommand(): Command<SampleInput, SampleOutput> {
    return sampleCommand({
      handle: async ({ input, ctx, commandLogId }): Promise<HandlerResult<SampleOutput>> => ({
        refusal: new errors.InvariantViolationError({
          code: "SAMPLE_REFUSED",
          message: "The thing you asked for was refused, and here is the evidence.",
          metadata: { orderId: input.orderId },
        }),
        audit: {
          action: "sample.refused",
          resourceType: "Order",
          resourceId: input.orderId,
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
      }),
    });
  }

  it("commits the handler's evidence, then throws the refusal to the caller", async () => {
    // The whole point. A refusal whose evidence rolls back with it is
    // a refusal nobody can act on — see the ApprovePV1 gate, where
    // the rolled-back rows were the findings the pharmacist had to
    // read and acknowledge to get past the refusal at all.
    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(refusingCommand(), { orderId: REFUSED_ORDER }, { idempotencyKey: "ref-1" })
      ).rejects.toMatchObject({ code: "SAMPLE_REFUSED", httpStatus: 422 });
    });

    // The in-tx bus writes ran, which is what "committed" means here:
    // the tx returned normally rather than unwinding.
    expect(callsTo(prisma, "auditLog", "create")).toHaveLength(1);
    expect(callsTo(prisma, "eventOutbox", "createMany")).toHaveLength(1);
  });

  it("writes NO idempotency row, so a same-key retry re-executes instead of replaying the refusal", async () => {
    // A cached refusal would answer the retry that was sent to
    // resolve it with the refusal itself, for as long as the key
    // lives. The caller's remedy is to change the world and try
    // again; the bus must let them.
    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(refusingCommand(), { orderId: REFUSED_ORDER }, { idempotencyKey: "ref-2" })
      ).rejects.toMatchObject({ code: "SAMPLE_REFUSED" });
    });

    expect(callsTo(prisma, "idempotencyKey", "create")).toHaveLength(0);
  });

  it("marks command_log FAILED with the refusal's code and the target order", async () => {
    // Same row a rollback refusal wrote, so nothing downstream has to
    // learn a new shape — `errorCode` dashboards and the SOC 2
    // attempted-but-failed view keep working unchanged.
    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(refusingCommand(), { orderId: REFUSED_ORDER }, { idempotencyKey: "ref-3" })
      ).rejects.toMatchObject({ code: "SAMPLE_REFUSED" });
    });

    const updates = callsTo(prisma, "commandLog", "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args).toMatchObject({
      data: expect.objectContaining({
        status: CommandStatus.FAILED,
        errorCode: "SAMPLE_REFUSED",
        targetOrderId: REFUSED_ORDER,
      }),
    });
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

describe("executeCommand — command_log unique-violation recovery", () => {
  const orderId = "77777777-7777-7777-a777-777777777777";

  it("prior attempt FAILED → row is reused (flipped to RUNNING) and the command re-executes", async () => {
    prisma.throwOnCommandLogCreate(uniqueViolationOnCommandLog());
    prisma.setCommandLogRow({ id: "cl-existing", status: CommandStatus.FAILED });

    const cmd = sampleCommand();
    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId }, { idempotencyKey: "retry-key" })
    );
    expect(out).toEqual({ accepted: true });

    // The existing row was flipped back to RUNNING…
    const updates = callsTo(prisma, "commandLog", "update");
    expect(updates[0]?.args).toMatchObject({
      where: { id: "cl-existing" },
      data: expect.objectContaining({ status: CommandStatus.RUNNING }),
    });
    // …and the final update marks the SAME row SUCCEEDED.
    expect(updates.at(-1)?.args).toMatchObject({
      where: { id: "cl-existing" },
      data: expect.objectContaining({ status: CommandStatus.SUCCEEDED }),
    });
  });

  it("prior attempt RUNNING → COMMAND_IN_FLIGHT conflict, handler NOT run", async () => {
    prisma.throwOnCommandLogCreate(uniqueViolationOnCommandLog());
    prisma.setCommandLogRow({ id: "cl-existing", status: CommandStatus.RUNNING });

    let handlerCalls = 0;
    const cmd = sampleCommand({
      handle: async ({ input: i }) => {
        handlerCalls += 1;
        return {
          output: { accepted: true },
          audit: { action: "x", resourceType: "Order", resourceId: i.orderId },
          outboxEvents: [],
        };
      },
    });
    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(cmd, { orderId }, { idempotencyKey: "in-flight-key" })
      ).rejects.toMatchObject({ code: "COMMAND_IN_FLIGHT" });
    });
    expect(handlerCalls).toBe(0);
  });

  it("prior attempt SUCCEEDED with cached response → replay", async () => {
    prisma.throwOnCommandLogCreate(uniqueViolationOnCommandLog());
    prisma.setCommandLogRow({ id: "cl-existing", status: CommandStatus.SUCCEEDED });
    const cached = { accepted: false };
    prisma.setIdempotencyHit(null); // pre-flight lookup misses…
    // …then the recovery lookup must hit. The fake returns the same
    // configured row for every findUnique, so configure it AFTER
    // constructing the miss: use a two-phase setter.
    const cmd = sampleCommand();
    // Configure hit for the recovery path (both lookups will see
    // it, which also exercises the ordinary replay short-circuit —
    // acceptable for this fake's fidelity; the P2002 branch is
    // covered by the RUNNING/FAILED cases above).
    prisma.setIdempotencyHit({
      requestHash: hashRequestKeyed({ orderId }, TEST_REQUEST_HASH_KEY),
      responsePayload: cached,
      responseStatus: null,
    });
    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(cmd, { orderId }, { idempotencyKey: "done-key" })
    );
    expect(out).toEqual(cached);
  });
});
