// DismissTypingSuggestion contract tests.
//
// Dismissal writes nothing to the prescription, so the interesting
// properties are about the RECORD it leaves:
//
//   - A reason code from a closed vocabulary is mandatory. The codes
//     separate "the model was wrong" from "the model was right and I
//     fixed it another way", which is the only thing that makes a
//     suggestion-quality report worth reading. A free-text or absent
//     reason would collapse that distinction.
//   - The order does not move. No version bump, no status change —
//     declining advice is not a workflow event.
//
// All data is synthetic. No PHI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import {
  DismissTypingSuggestion,
  TYPING_SUGGESTION_DISMISS_REASONS,
} from "./dismiss-typing-suggestion.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const RX_ID = "00000000-0000-4000-8000-00000000000b";
const RUN_ID = "00000000-0000-4000-8000-00000000000c";
const SUGGESTION_ID = "00000000-0000-4000-8000-00000000000d";

const typistGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.AI_TYPING_SUGGESTIONS_USE]),
  },
];

function ctxFor(): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

const validInput = () => ({
  orderId: ORDER_ID,
  suggestionId: SUGGESTION_ID,
  dismissReasonCode: "SOURCE_DOCUMENT_CONFIRMS_TYPED_VALUE" as const,
});

function proposedSuggestion(overrides: Record<string, unknown> = {}) {
  return {
    id: SUGGESTION_ID,
    prescriptionId: RX_ID,
    runId: RUN_ID,
    source: "MODEL",
    findingCode: null,
    field: "daysSupply",
    confidencePercent: 94,
    status: "PROPOSED",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake prisma
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  lockedRow?: { currentStatus: string; version: number } | null;
  suggestion?: Record<string, unknown> | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "TYPING_IN_PROGRESS", version: 1 }
      : overrides.lockedRow;
  const suggestion =
    overrides.suggestion === undefined ? proposedSuggestion() : overrides.suggestion;

  const tx = {
    typingSuggestion: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "typingSuggestion", op: "findFirst", args });
        return suggestion;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "typingSuggestion", op: "update", args });
        return { id: SUGGESTION_ID };
      }),
    },
    prescription: {
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "prescription", op: "update", args });
        return { id: RX_ID };
      }),
    },
    order: {
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "update", args });
        return { id: ORDER_ID };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: 1 };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return { sequenceNumber: 6 };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-7" };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-1" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "findUnique", args });
        return null;
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditLog", op: "create", args });
        return { id: "al-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
        return { organizationId: ORG_ID, latestHash: Buffer.alloc(32), latestSeq: 1n };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        return { count: 1 };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { ok: true };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
    },
    $queryRaw: vi.fn(async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
      const joined = template.join("?");
      const isOrderLock = /\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined);
      calls.push({
        table: "$queryRaw",
        op: isOrderLock ? "select_for_update_order" : "raw",
        args: { sql: joined, values: [...values] },
      });
      if (!isOrderLock) return [];
      return lockedRow === null
        ? []
        : [
            {
              id: ORDER_ID,
              organizationId: ORG_ID,
              clinicId: CLINIC_ID,
              siteId: SITE_ID,
              currentStatus: lockedRow.currentStatus,
              version: lockedRow.version,
              workflowPolicyId: POLICY_ID,
              workflowPolicyVersion: 1,
            },
          ];
    }),
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        const joined = template.join("?");
        calls.push({
          table: "$executeRaw",
          op: /\bset_config\b/i.test(joined) ? "set_config" : "raw",
          args: { sql: joined, values: [...values] },
        });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cl-pre" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { ok: true };
      }),
    },
    idempotencyKey: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { client, calls };
}

function callsOf(calls: FakeCall[], table: string, op: string): FakeCall[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function configureBus(client: unknown): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-08-16T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
}

beforeEach(() => {
  configureRbac({
    loader: new InMemoryPermissionLoader([
      { organizationId: ORG_ID, userId: USER_ID, grants: typistGrants },
    ]),
  });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("DismissTypingSuggestion — happy path", () => {
  it("records the reason and the actor, and touches nothing else", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(DismissTypingSuggestion, validInput(), { idempotencyKey: "dis-1" })
    );

    expect(out).toEqual({
      suggestionId: SUGGESTION_ID,
      dismissReasonCode: "SOURCE_DOCUMENT_CONFIRMS_TYPED_VALUE",
    });

    expect(
      (callsOf(fake.calls, "typingSuggestion", "update")[0]!.args as { data: unknown }).data
    ).toEqual({
      status: "DISMISSED",
      dismissReasonCode: "SOURCE_DOCUMENT_CONFIRMS_TYPED_VALUE",
      resolvedByUserId: USER_ID,
      resolvedAt: new Date("2026-08-16T12:00:00.000Z"),
    });

    expect(callsOf(fake.calls, "prescription", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("audits the dismissal with the reason and the proposal's provenance", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(DismissTypingSuggestion, validInput(), { idempotencyKey: "dis-2" })
    );

    const audit = (
      callsOf(fake.calls, "auditLog", "create")[0]!.args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("ai.typing_suggestion.dismissed");
    expect(audit.metadata).toMatchObject({
      field: "daysSupply",
      source: "MODEL",
      confidencePercent: 94,
      dismissReasonCode: "SOURCE_DOCUMENT_CONFIRMS_TYPED_VALUE",
    });

    const outbox = callsOf(fake.calls, "eventOutbox", "createMany")[0]!;
    expect((outbox.args as { data: Array<Record<string, unknown>> }).data[0]).toMatchObject({
      eventType: "ai.typing_suggestion.dismissed.v1",
    });
  });

  it("accepts every code in the vocabulary", async () => {
    for (const reason of TYPING_SUGGESTION_DISMISS_REASONS) {
      const fake = buildPrismaFake();
      configureBus(fake.client);

      const out = await withTenancyContext(ctxFor(), () =>
        executeCommand(
          DismissTypingSuggestion,
          { ...validInput(), dismissReasonCode: reason },
          { idempotencyKey: `dis-${reason}` }
        )
      );

      expect(out.dismissReasonCode).toBe(reason);
      resetCommandBusConfigurationForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("DismissTypingSuggestion — reason code is mandatory", () => {
  it("rejects a missing reason", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          DismissTypingSuggestion,
          { orderId: ORDER_ID, suggestionId: SUGGESTION_ID } as never,
          { idempotencyKey: "r-1" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });

    expect(callsOf(fake.calls, "typingSuggestion", "update")).toHaveLength(0);
  });

  it("rejects free text outside the vocabulary", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          DismissTypingSuggestion,
          { ...validInput(), dismissReasonCode: "looked wrong to me" } as never,
          { idempotencyKey: "r-2" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

describe("DismissTypingSuggestion — lifecycle + state", () => {
  it("refuses when the order has left typing", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "TYPED_READY_FOR_PV1", version: 2 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DismissTypingSuggestion, validInput(), { idempotencyKey: "s-1" })
      ).rejects.toMatchObject({ code: "TYPING_SUGGESTION_ORDER_NOT_IN_TYPING" });
    });
  });

  it("404s a suggestion that is not on this order", async () => {
    const fake = buildPrismaFake({ suggestion: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DismissTypingSuggestion, validInput(), { idempotencyKey: "s-2" })
      ).rejects.toMatchObject({ code: "TYPING_SUGGESTION_NOT_FOUND" });
    });
  });

  it("refuses to re-resolve an already-accepted suggestion", async () => {
    const fake = buildPrismaFake({ suggestion: proposedSuggestion({ status: "ACCEPTED" }) });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DismissTypingSuggestion, validInput(), { idempotencyKey: "s-3" })
      ).rejects.toMatchObject({ code: "TYPING_SUGGESTION_NOT_PROPOSED" });
    });

    expect(callsOf(fake.calls, "typingSuggestion", "update")).toHaveLength(0);
  });

  it("requires the AI-assist permission", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    resetRbacConfigurationForTests();
    configureRbac({
      loader: new InMemoryPermissionLoader([
        {
          organizationId: ORG_ID,
          userId: USER_ID,
          grants: [
            {
              roleScope: RoleScope.ORGANIZATION,
              grantScope: { siteId: null, clinicId: null, teamId: null },
              permissions: new Set([PERMISSIONS.TYPING_COMPLETE]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(DismissTypingSuggestion, validInput(), { idempotencyKey: "s-4" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });
});
