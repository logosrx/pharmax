// executeSystemCommand contract.
//
// Asserts the system-command path: no RBAC, no user context, in-tx
// command_log, handler resolves the target organizationId, audit
// metadata includes the system context reason, and the replay
// recovery that turns a `command_log` unique violation into the prior
// attempt's outcome instead of a raw Prisma P2002.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { CommandStatus } from "@pharmax/database";
import { withSystemContext, withTenancyContext, buildTenancyContext } from "@pharmax/tenancy";

import { configureCommandBus, resetCommandBusConfigurationForTests } from "./configure.js";
import { executeSystemCommand } from "./execute-system-command.js";
import type { SystemCommand } from "./types.js";
import {
  buildFakeConfig,
  buildFakePrisma,
  callsTo,
  uniqueViolationOnCommandLog,
  type FakePrisma,
} from "./test-helpers.js";

interface BootstrapInput {
  readonly slug: string;
  readonly name: string;
}
interface BootstrapOutput {
  readonly organizationId: string;
}

function bootstrapCommand(
  overrides: Partial<SystemCommand<BootstrapInput, BootstrapOutput>> = {}
): SystemCommand<BootstrapInput, BootstrapOutput> {
  return {
    name: "BootstrapOrg",
    inputSchema: z.object({ slug: z.string().min(2), name: z.string().min(2) }),
    async handle({ input, commandLogId }) {
      const orgId = "99999999-9999-9999-9999-999999999999";
      return {
        output: { organizationId: orgId },
        targetOrganizationId: orgId,
        audit: {
          action: "organization.created",
          resourceType: "Organization",
          resourceId: orgId,
          metadata: { slug: input.slug, commandLogId },
        },
        outboxEvents: [
          {
            eventType: "organization.created.v1",
            aggregateType: "Organization",
            aggregateId: orgId,
            payload: { organizationId: orgId, slug: input.slug, name: input.name },
          },
        ],
      };
    },
    ...overrides,
  };
}

let prisma: FakePrisma;

beforeEach(() => {
  prisma = buildFakePrisma();
  configureCommandBus(buildFakeConfig(prisma));
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
});

describe("executeSystemCommand — happy path", () => {
  it("writes command_log + audit + outbox under the handler-returned orgId, marks SUCCEEDED", async () => {
    const out = await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(bootstrapCommand(), { slug: "acme", name: "Acme" })
    );
    expect(out).toEqual({
      organizationId: "99999999-9999-9999-9999-999999999999",
    });

    // command_log row created INSIDE the tx (no pre-tx create).
    // Our fake counts all create calls; both the pre-tx and in-tx
    // delegates flow through `record("commandLog", "create")`, but
    // the system path only invokes it once (in-tx).
    const cmdCreates = callsTo(prisma, "commandLog", "create");
    expect(cmdCreates).toHaveLength(1);
    expect(cmdCreates[0]?.args).toMatchObject({
      data: expect.objectContaining({
        organizationId: "99999999-9999-9999-9999-999999999999",
        commandName: "BootstrapOrg",
        actorUserId: null,
        status: CommandStatus.RUNNING,
      }),
    });

    // Step 8a — System path MUST set pharmax.system_context='on'
    // inside the tx BEFORE any audit/outbox write. We assert both
    // that the GUC was applied and that the reason string was bound
    // as a parameter (not interpolated into SQL).
    // The system GUC (organization_id clear + system_context='on' +
    // reason) is issued as a SINGLE round trip — one `$executeRaw`
    // with all three set_config calls in one SELECT target list.
    const gucCalls = callsTo(prisma, "$executeRaw", "set_config");
    expect(gucCalls.length).toBeGreaterThanOrEqual(1);
    const firstGucIdx = prisma.calls.indexOf(gucCalls[0]!);
    const firstAuditIdx = prisma.calls.indexOf(callsTo(prisma, "auditLog", "create")[0]!);
    expect(firstGucIdx).toBeLessThan(firstAuditIdx);
    const gucValues = gucCalls.flatMap(
      (c) => (c.args as { values: ReadonlyArray<unknown> }).values
    );
    expect(gucValues).toContain("on");
    expect(gucValues).toContain("bootstrap:test");

    expect(callsTo(prisma, "auditLog", "create")).toHaveLength(1);
    const auditArgs = callsTo(prisma, "auditLog", "create")[0]?.args as {
      data: { metadata: Record<string, unknown> };
    };
    expect(auditArgs.data.metadata["systemContextReason"]).toBe("bootstrap:test");

    expect(callsTo(prisma, "eventOutbox", "createMany")).toHaveLength(1);

    const updates = callsTo(prisma, "commandLog", "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args).toMatchObject({
      data: expect.objectContaining({ status: CommandStatus.SUCCEEDED }),
    });
  });
});

describe("executeSystemCommand — context guards", () => {
  it("rejects when called WITHOUT a system context", async () => {
    await expect(
      executeSystemCommand(bootstrapCommand(), { slug: "acme", name: "Acme" })
    ).rejects.toMatchObject({ code: "COMMAND_SYSTEM_CONTEXT_REQUIRED" });
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
  });

  it("rejects when called inside a USER context (not system)", async () => {
    const ctx = buildTenancyContext({
      organizationId: "org-1",
      actor: { userId: "u", correlationId: "01CORRELATION0000000000000" },
    });
    await withTenancyContext(ctx, async () => {
      await expect(
        executeSystemCommand(bootstrapCommand(), { slug: "acme", name: "Acme" })
      ).rejects.toMatchObject({ code: "COMMAND_SYSTEM_CONTEXT_REQUIRED" });
    });
  });
});

describe("executeSystemCommand — failure paths", () => {
  it("Zod validation failure → ValidationError, no DB writes", async () => {
    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(bootstrapCommand(), { slug: "x", name: "x" })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
  });

  it("handler throws → no command_log row (handler runs before in-tx create), error rethrown", async () => {
    const cmd = bootstrapCommand({
      async handle() {
        throw new Error("ops outage");
      },
    });
    await withSystemContext("bootstrap:test", async () => {
      await expect(executeSystemCommand(cmd, { slug: "acme", name: "Acme" })).rejects.toThrow(
        /ops outage/
      );
    });
    expect(callsTo(prisma, "commandLog")).toHaveLength(0);
  });
});

// The scenario these cover is not Stripe redelivery (the webhook inbox
// dedupes that at ingest). It is a worker that crashes AFTER the
// command's transaction commits but BEFORE the inbox row is marked
// processed: the lease expires, the drain re-claims the row, and the
// same idempotency key comes back through the bus. Without this
// recovery the re-dispatch surfaces a raw P2002 and the row never
// drains.
describe("executeSystemCommand — command_log unique-violation recovery", () => {
  const ORG_ID = "99999999-9999-9999-9999-999999999999";

  it("replays the prior SUCCEEDED attempt's recorded output instead of throwing P2002", async () => {
    prisma.throwOnCommandLogCreate(uniqueViolationOnCommandLog());
    prisma.setCommandLogRow({
      id: "cl-prior",
      status: CommandStatus.SUCCEEDED,
      responsePayload: { organizationId: ORG_ID },
    });

    const out = await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(
        bootstrapCommand(),
        { slug: "acme", name: "Acme" },
        {
          idempotencyKey: "stripe-event:evt_replay",
        }
      )
    );

    expect(out).toEqual({ organizationId: ORG_ID });

    // Nothing durable from the replayed attempt: its tx rolled back on
    // the violation, which is precisely what makes the replay safe.
    expect(callsTo(prisma, "auditLog", "create")).toHaveLength(0);
    expect(callsTo(prisma, "eventOutbox", "createMany")).toHaveLength(0);
    expect(callsTo(prisma, "commandLog", "update")).toHaveLength(0);
  });

  it("scopes the recovery lookup to the org the handler resolved, under the system GUC", async () => {
    prisma.throwOnCommandLogCreate(uniqueViolationOnCommandLog());
    prisma.setCommandLogRow({
      id: "cl-prior",
      status: CommandStatus.SUCCEEDED,
      responsePayload: { organizationId: ORG_ID },
    });

    await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(
        bootstrapCommand(),
        { slug: "acme", name: "Acme" },
        {
          idempotencyKey: "stripe-event:evt_scope",
        }
      )
    );

    // The org id is only knowable from the handler's return value, so
    // an unscoped lookup here would read another tenant's row.
    const lookups = callsTo(prisma, "commandLog", "findUnique");
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.args).toMatchObject({
      where: {
        organizationId_commandName_idempotencyKey: {
          organizationId: ORG_ID,
          commandName: "BootstrapOrg",
          idempotencyKey: "stripe-event:evt_scope",
        },
      },
    });

    // command_log is RLS ENABLE + FORCE: the recovery's own
    // transaction must set the system GUC before it reads.
    const lookupIdx = prisma.calls.indexOf(lookups[0]!);
    const gucBeforeLookup = callsTo(prisma, "$executeRaw", "set_config").filter(
      (c) => prisma.calls.indexOf(c) < lookupIdx
    );
    expect(gucBeforeLookup.length).toBeGreaterThanOrEqual(2);
  });

  it("runs the handler for the replayed attempt — the rollback is what makes it safe", async () => {
    prisma.throwOnCommandLogCreate(uniqueViolationOnCommandLog());
    prisma.setCommandLogRow({
      id: "cl-prior",
      status: CommandStatus.SUCCEEDED,
      responsePayload: { organizationId: ORG_ID },
    });

    let handlerCalls = 0;
    const cmd = bootstrapCommand({
      async handle({ input }) {
        handlerCalls += 1;
        return {
          output: { organizationId: ORG_ID },
          targetOrganizationId: ORG_ID,
          audit: { action: "organization.created", resourceType: "Organization" },
          outboxEvents: [
            {
              eventType: "organization.created.v1",
              aggregateType: "Organization",
              aggregateId: ORG_ID,
              payload: { slug: input.slug },
            },
          ],
        };
      },
    });

    await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(
        cmd,
        { slug: "acme", name: "Acme" },
        {
          idempotencyKey: "stripe-event:evt_handler",
        }
      )
    );

    // Unlike the tenant executor — which short-circuits in its
    // PRE-tx lookup and never calls the handler — this one cannot
    // know the target org until the handler has run. The handler
    // therefore executes, and its writes are discarded with the tx.
    // Pinned because it is a real constraint on system handlers:
    // side effects outside `tx` would survive a replay.
    expect(handlerCalls).toBe(1);
  });

  it("prior attempt RUNNING → COMMAND_IN_FLIGHT, no replayed output", async () => {
    prisma.throwOnCommandLogCreate(uniqueViolationOnCommandLog());
    prisma.setCommandLogRow({ id: "cl-prior", status: CommandStatus.RUNNING });

    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(
          bootstrapCommand(),
          { slug: "acme", name: "Acme" },
          {
            idempotencyKey: "stripe-event:evt_inflight",
          }
        )
      ).rejects.toMatchObject({ code: "COMMAND_IN_FLIGHT" });
    });
  });

  it("prior attempt FAILED → COMMAND_ALREADY_EXECUTED; the row is NOT reused", async () => {
    prisma.throwOnCommandLogCreate(uniqueViolationOnCommandLog());
    prisma.setCommandLogRow({ id: "cl-prior", status: CommandStatus.FAILED });

    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(
          bootstrapCommand(),
          { slug: "acme", name: "Acme" },
          {
            idempotencyKey: "stripe-event:evt_failed",
          }
        )
      ).rejects.toMatchObject({ code: "COMMAND_ALREADY_EXECUTED" });
    });

    // The tenant executor flips a FAILED row back to RUNNING and
    // re-executes (pinned in execute-command.test.ts). This executor
    // must NOT: it writes command_log inside the handler tx, so a
    // rolled-back attempt leaves no row, and a FAILED row here is not
    // evidence that the mutation was undone. Reusing it would
    // re-apply a money command with the unique index disarmed.
    expect(callsTo(prisma, "commandLog", "update")).toHaveLength(0);
  });

  it("conflicting row vanished between the violation and the read → COMMAND_IN_FLIGHT", async () => {
    prisma.throwOnCommandLogCreate(uniqueViolationOnCommandLog());
    prisma.setCommandLogRow(null);

    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(
          bootstrapCommand(),
          { slug: "acme", name: "Acme" },
          {
            idempotencyKey: "stripe-event:evt_vanished",
          }
        )
      ).rejects.toMatchObject({ code: "COMMAND_IN_FLIGHT" });
    });
  });

  it("prior attempt SUCCEEDED but recorded no output → COMMAND_ALREADY_EXECUTED", async () => {
    prisma.throwOnCommandLogCreate(uniqueViolationOnCommandLog());
    prisma.setCommandLogRow({ id: "cl-prior", status: CommandStatus.SUCCEEDED });

    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(
          bootstrapCommand(),
          { slug: "acme", name: "Acme" },
          {
            idempotencyKey: "stripe-event:evt_nopayload",
          }
        )
      ).rejects.toMatchObject({ code: "COMMAND_ALREADY_EXECUTED" });
    });
  });

  it("a genuinely new key executes normally and never consults the prior-attempt lookup", async () => {
    prisma.setCommandLogRow({
      id: "cl-prior",
      status: CommandStatus.SUCCEEDED,
      responsePayload: { organizationId: "should-not-be-read" },
    });

    const out = await withSystemContext("bootstrap:test", () =>
      executeSystemCommand(
        bootstrapCommand(),
        { slug: "acme", name: "Acme" },
        {
          idempotencyKey: "stripe-event:evt_fresh",
        }
      )
    );

    expect(out).toEqual({ organizationId: ORG_ID });
    expect(callsTo(prisma, "commandLog", "findUnique")).toHaveLength(0);
    expect(callsTo(prisma, "auditLog", "create")).toHaveLength(1);
    expect(callsTo(prisma, "eventOutbox", "createMany")).toHaveLength(1);
    expect(callsTo(prisma, "commandLog", "update")[0]?.args).toMatchObject({
      data: expect.objectContaining({ status: CommandStatus.SUCCEEDED }),
    });
  });

  it("a non-command_log error still surfaces unchanged", async () => {
    // The recovery must not swallow a P2002 raised by the handler's own
    // domain writes; only the command_log key collision is a replay.
    const cmd = bootstrapCommand({
      async handle() {
        throw new Error("duplicate slug");
      },
    });

    await withSystemContext("bootstrap:test", async () => {
      await expect(
        executeSystemCommand(
          cmd,
          { slug: "acme", name: "Acme" },
          {
            idempotencyKey: "stripe-event:evt_other",
          }
        )
      ).rejects.toThrow(/duplicate slug/);
    });
    expect(callsTo(prisma, "commandLog", "findUnique")).toHaveLength(0);
  });
});
