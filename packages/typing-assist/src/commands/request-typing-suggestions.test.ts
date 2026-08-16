// RequestTypingSuggestions contract tests.
//
// This is the entry point of the review loop, and it has two
// properties worth pinning above the ordinary command contract:
//
//   1. THE GATE DECIDES THE EVENT. The model stage runs only when the
//      org's policy and the product's guardrail both permit it. When
//      the gate is closed the run is recorded as MODEL_SKIPPED with a
//      reason and NO event is emitted — so a tenant who never enabled
//      the model, or who disabled it for one product, cannot have a
//      prompt built for them by any route. The deterministic findings
//      still produce proposals: those are arithmetic, not AI.
//   2. IT DOES NOT MOVE THE ORDER. No version bump, no status change.
//      Asking for a review must never CAS-conflict a colleague's real
//      edit, and must never look like a workflow transition.
//
// All data is synthetic. No PHI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { Prisma, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext, type TenancyContext } from "@pharmax/tenancy";

import { RequestTypingSuggestions } from "./request-typing-suggestions.js";

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
const PRODUCT_ID = "00000000-0000-4000-8000-00000000000e";

const typistGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.AI_TYPING_SUGGESTIONS_USE]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const validInput = () => ({ orderId: ORDER_ID, prescriptionId: RX_ID });

/** A clean draft: no deterministic findings. */
function cleanPrescription(overrides: Record<string, unknown> = {}) {
  return {
    id: RX_ID,
    drugNdc: "00093-0058-01",
    quantityAuthorized: new Prisma.Decimal(60),
    daysSupply: 30,
    refillsAuthorized: 2,
    refillsRemaining: 2,
    originalDateWritten: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: new Date("2027-08-01T00:00:00.000Z"),
    daw: 0,
    controlledSubstanceSchedule: "NON_CONTROLLED",
    earliestFillDate: null,
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
  orderLineFound?: boolean;
  prescription?: Record<string, unknown> | null;
  product?: { id: string; controlledSubstanceSchedule: string } | null;
  guardrail?: {
    aiSuggestionsEnabled: boolean;
    maxQuantityPerFill: Prisma.Decimal | null;
    maxDaysSupplyPerFill: number | null;
    maxRefillsAuthorized: number | null;
    version: number;
  } | null;
  policy?: {
    typingAssistEnabled: boolean;
    minConfidencePercent: number;
    allowControlledSubstanceSuggestions: boolean;
    version: number;
  } | null;
  supersededCount?: number;
}

function buildPrismaFake(overrides: FakeOverrides = {}): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "TYPING_IN_PROGRESS", version: 1 }
      : overrides.lockedRow;
  const prescription =
    overrides.prescription === undefined ? cleanPrescription() : overrides.prescription;
  const product =
    overrides.product === undefined
      ? { id: PRODUCT_ID, controlledSubstanceSchedule: "NON_CONTROLLED" }
      : overrides.product;
  const guardrail = overrides.guardrail === undefined ? null : overrides.guardrail;
  const policy =
    overrides.policy === undefined
      ? {
          typingAssistEnabled: true,
          minConfidencePercent: 90,
          allowControlledSubstanceSuggestions: false,
          version: 2,
        }
      : overrides.policy;

  const tx = {
    orderLine: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "findFirst", args });
        return (overrides.orderLineFound ?? true) ? { id: "line-1" } : null;
      }),
    },
    prescription: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "prescription", op: "findFirst", args });
        return prescription;
      }),
    },
    product: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "findFirst", args });
        return product;
      }),
    },
    productAiGuardrail: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "productAiGuardrail", op: "findFirst", args });
        return guardrail;
      }),
    },
    aiAssistPolicy: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "aiAssistPolicy", op: "findFirst", args });
        return policy;
      }),
    },
    typingSuggestionRun: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "typingSuggestionRun", op: "create", args });
        return { id: RUN_ID };
      }),
    },
    typingSuggestion: {
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "typingSuggestion", op: "updateMany", args });
        return { count: overrides.supersededCount ?? 0 };
      }),
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "typingSuggestion", op: "createMany", args });
        return { count: (args as { data: unknown[] }).data.length };
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
        return { sequenceNumber: 4 };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-5" };
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
        return { count: (args as { data: unknown[] }).data.length };
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
      const op = isOrderLock ? "select_for_update_order" : "raw";
      calls.push({ table: "$queryRaw", op, args: { sql: joined, values: [...values] } });
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
        const op = /\bset_config\b/i.test(joined) ? "set_config" : "raw";
        calls.push({ table: "$executeRaw", op, args: { sql: joined, values: [...values] } });
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

function runData(calls: FakeCall[]): Record<string, unknown> {
  const call = callsOf(calls, "typingSuggestionRun", "create")[0];
  if (call === undefined) throw new Error("no typingSuggestionRun.create call");
  return (call.args as { data: Record<string, unknown> }).data;
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
// Gate open
// ---------------------------------------------------------------------------

describe("RequestTypingSuggestions — gate open", () => {
  it("records a PENDING_MODEL run and emits the event that schedules the worker", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "req-1" })
    );

    expect(out).toMatchObject({
      runId: RUN_ID,
      status: "PENDING_MODEL",
      modelSkipReasonCode: null,
    });

    expect(runData(fake.calls)).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      prescriptionId: RX_ID,
      requestedByUserId: USER_ID,
      status: "PENDING_MODEL",
      modelSuggestionsPermitted: true,
      modelSkipReasonCode: null,
      policyVersion: 2,
      minConfidencePercent: 90,
    });

    const outbox = callsOf(fake.calls, "eventOutbox", "createMany")[0];
    expect((outbox!.args as { data: Array<Record<string, unknown>> }).data[0]).toMatchObject({
      eventType: "ai.typing_suggestion_run.requested.v1",
    });
  });

  it("does not move the order's status or version", async () => {
    // A review request is a read of the draft plus new proposal rows.
    // Bumping the version here would CAS-conflict a colleague mid-edit
    // for no state change at all.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "req-2" })
    );

    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "update")).toHaveLength(0);
  });

  it("supersedes prior open proposals for the same prescription", async () => {
    // Two runs' proposals for one field would ask the technician to
    // adjudicate between stale and fresh advice.
    const fake = buildPrismaFake({ supersededCount: 3 });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "req-3" })
    );

    expect(out.supersededSuggestionCount).toBe(3);
    expect(
      (callsOf(fake.calls, "typingSuggestion", "updateMany")[0]!.args as { where: unknown }).where
    ).toEqual({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      prescriptionId: RX_ID,
      status: "PROPOSED",
    });
  });

  it("creates no suggestion rows for a clean draft", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "req-4" })
    );

    expect(out.deterministicFindingCount).toBe(0);
    expect(out.deterministicSuggestionCount).toBe(0);
    expect(callsOf(fake.calls, "typingSuggestion", "createMany")).toHaveLength(0);
  });

  it("persists a deterministic proposal for a flawed draft", async () => {
    // refillsRemaining (4) exceeds refillsAuthorized (2) — one correct
    // answer, so the fix is created up front with no model involved.
    const fake = buildPrismaFake({
      prescription: cleanPrescription({ refillsAuthorized: 2, refillsRemaining: 4 }),
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "req-5" })
    );

    expect(out.deterministicSuggestionCount).toBeGreaterThan(0);
    const created = (
      callsOf(fake.calls, "typingSuggestion", "createMany")[0]!.args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(created[0]).toMatchObject({
      source: "DETERMINISTIC",
      field: "refillsRemaining",
      currentValue: 4,
      suggestedValue: 2,
      findingCode: "TA_REFILLS_REMAINING_EXCEEDS_AUTHORIZED",
    });
  });
});

// ---------------------------------------------------------------------------
// Gate closed
// ---------------------------------------------------------------------------

describe("RequestTypingSuggestions — gate closed", () => {
  it("skips the model when the org never enabled typing assist", async () => {
    const fake = buildPrismaFake({ policy: null });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "gate-1" })
    );

    expect(out).toMatchObject({ status: "MODEL_SKIPPED", modelSkipReasonCode: "POLICY_DISABLED" });
    // No event means no worker pickup means no prompt is ever built
    // for a tenant that did not opt in.
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
    expect(runData(fake.calls)).toMatchObject({
      status: "MODEL_SKIPPED",
      modelSuggestionsPermitted: false,
      modelSkipReasonCode: "POLICY_DISABLED",
      completedAt: new Date("2026-08-16T12:00:00.000Z"),
    });
  });

  it("skips the model when the org's policy is disabled", async () => {
    const fake = buildPrismaFake({
      policy: {
        typingAssistEnabled: false,
        minConfidencePercent: 90,
        allowControlledSubstanceSuggestions: true,
        version: 5,
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "gate-2" })
    );

    expect(out.modelSkipReasonCode).toBe("POLICY_DISABLED");
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("skips the model when THIS PRODUCT's guardrail switch is off", async () => {
    // Per-product opt-out: the org is on, this product is not. This is
    // the tenant-authored kill switch phase 1 exists to provide.
    const fake = buildPrismaFake({
      guardrail: {
        aiSuggestionsEnabled: false,
        maxQuantityPerFill: null,
        maxDaysSupplyPerFill: null,
        maxRefillsAuthorized: null,
        version: 3,
      },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "gate-3" })
    );

    expect(out.modelSkipReasonCode).toBe("PRODUCT_GUARDRAIL_DISABLED");
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("skips the model on a controlled substance the org has not opted in for", async () => {
    const fake = buildPrismaFake({
      prescription: cleanPrescription({ controlledSubstanceSchedule: "CII" }),
      product: { id: PRODUCT_ID, controlledSubstanceSchedule: "CII" },
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "gate-4" })
    );

    expect(out.modelSkipReasonCode).toBe("CONTROLLED_SUBSTANCE_NOT_OPTED_IN");
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("still creates deterministic proposals when the model is gated off", async () => {
    // The gate governs the MODEL. Arithmetic and regulation checks are
    // not AI and are not opt-in.
    const fake = buildPrismaFake({
      policy: null,
      prescription: cleanPrescription({ refillsAuthorized: 1, refillsRemaining: 6 }),
    });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "gate-5" })
    );

    expect(out.status).toBe("MODEL_SKIPPED");
    expect(out.deterministicSuggestionCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("RequestTypingSuggestions — guards", () => {
  for (const status of ["RECEIVED", "TYPED_READY_FOR_PV1", "ON_HOLD"]) {
    it(`refuses while the order is ${status}`, async () => {
      const fake = buildPrismaFake({ lockedRow: { currentStatus: status, version: 1 } });
      configureBus(fake.client);

      await withTenancyContext(ctxFor(), async () => {
        await expect(
          executeCommand(RequestTypingSuggestions, validInput(), {
            idempotencyKey: `guard-${status}`,
          })
        ).rejects.toMatchObject({ code: "TYPING_SUGGESTIONS_ORDER_NOT_IN_TYPING" });
      });

      expect(callsOf(fake.calls, "typingSuggestionRun", "create")).toHaveLength(0);
    });
  }

  it("refuses a prescription that is not attached to this order", async () => {
    // Without this, a valid prescription id from another order (same
    // org) could be reviewed — and then edited — through an order the
    // technician does happen to hold.
    const fake = buildPrismaFake({ orderLineFound: false });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "guard-line" })
      ).rejects.toMatchObject({ code: "TYPING_SUGGESTIONS_PRESCRIPTION_NOT_ON_ORDER" });
    });

    expect(callsOf(fake.calls, "typingSuggestionRun", "create")).toHaveLength(0);
  });

  it("scopes the order-line check by org, order, AND prescription", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "guard-scope" })
    );

    expect(
      (callsOf(fake.calls, "orderLine", "findFirst")[0]!.args as { where: unknown }).where
    ).toEqual({ organizationId: ORG_ID, orderId: ORDER_ID, prescriptionId: RX_ID });
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
              permissions: new Set([PERMISSIONS.TYPING_START]),
            },
          ],
        },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(RequestTypingSuggestions, validInput(), { idempotencyKey: "guard-rbac" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });
});
