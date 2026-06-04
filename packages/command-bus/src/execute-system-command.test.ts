// executeSystemCommand contract.
//
// Asserts the system-command path: no RBAC, no user context, in-tx
// command_log, handler resolves the target organizationId, audit
// metadata includes the system context reason.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { CommandStatus } from "@pharmax/database";
import { withSystemContext, withTenancyContext, buildTenancyContext } from "@pharmax/tenancy";

import { configureCommandBus, resetCommandBusConfigurationForTests } from "./configure.js";
import { executeSystemCommand } from "./execute-system-command.js";
import type { SystemCommand } from "./types.js";
import { buildFakeConfig, buildFakePrisma, callsTo, type FakePrisma } from "./test-helpers.js";

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
