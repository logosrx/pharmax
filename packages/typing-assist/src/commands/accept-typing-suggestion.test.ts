// AcceptTypingSuggestion contract tests.
//
// This command is the entire safety story of the AI typing panel: it is
// the ONLY path from a model proposal to a prescription column, so
// every guard it claims has to be pinned. The cases that matter most
// are the two re-checks against LIVE rows, because they are what stops
// "AI assist" from becoming "AI overwrite":
//
//   - STALE: the field moved after the proposal was generated (a
//     colleague edited it, or an earlier accept did). Accepting advice
//     about a value that no longer exists is refused.
//   - GUARDRAIL: the tenant tightened a ceiling after the proposal was
//     generated. The live ceiling wins over the run's snapshot.
//
// Plus the ordinary command contract: state guard, optimistic
// concurrency, RBAC, and the audit/event/outbox chain.
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

import { AcceptTypingSuggestion } from "./accept-typing-suggestion.js";

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
const PRODUCT_ID = "00000000-0000-4000-8000-00000000000e";

const typistGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.AI_TYPING_SUGGESTIONS_USE]),
  },
];

const typingOnlyGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.TYPING_START, PERMISSIONS.TYPING_COMPLETE]),
  },
];

function ctxFor(overrides: Partial<TenancyContext> = {}): TenancyContext {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
    ...overrides,
  });
}

const validInput = () => ({
  orderId: ORDER_ID,
  suggestionId: SUGGESTION_ID,
  expectedOrderVersion: 1,
});

/** A PROPOSED suggestion: cap refills remaining 9 → 8. */
function proposedSuggestion(overrides: Record<string, unknown> = {}) {
  return {
    id: SUGGESTION_ID,
    prescriptionId: RX_ID,
    runId: RUN_ID,
    source: "DETERMINISTIC",
    findingCode: "TA_REFILLS_REMAINING_EXCEEDS_AUTHORIZED",
    field: "refillsRemaining",
    currentValue: 9,
    suggestedValue: 8,
    confidencePercent: null,
    status: "PROPOSED",
    ...overrides,
  };
}

function prescriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RX_ID,
    drugNdc: "00093-0058-01",
    quantityAuthorized: new Prisma.Decimal(60),
    daysSupply: 30,
    refillsAuthorized: 8,
    refillsRemaining: 9,
    daw: 0,
    expiresAt: new Date("2027-08-01T00:00:00.000Z"),
    earliestFillDate: null,
    controlledSubstanceSchedule: "NON_CONTROLLED",
    sigStructureKind: "FIXED",
    doseAmount: new Prisma.Decimal(1),
    doseUnit: "TABLET",
    dosesPerDay: new Prisma.Decimal(2),
    drugStrength: "500 mg",
    drugForm: "TABLET",
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
  prescription?: Record<string, unknown> | null;
  /** Live guardrail row at accept time; undefined → no guardrail. */
  guardrail?: {
    maxQuantityPerFill: Prisma.Decimal | null;
    maxDaysSupplyPerFill: number | null;
    maxRefillsAuthorized: number | null;
    version: number;
  } | null;
  supersededCount?: number;
  orderUpdateManyCount?: number;
}

function buildPrismaFake(overrides: FakeOverrides = {}): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "TYPING_IN_PROGRESS", version: 1 }
      : overrides.lockedRow;
  const suggestion =
    overrides.suggestion === undefined ? proposedSuggestion() : overrides.suggestion;
  const prescription =
    overrides.prescription === undefined ? prescriptionRow() : overrides.prescription;
  const guardrail = overrides.guardrail ?? null;

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
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "typingSuggestion", op: "updateMany", args });
        return { count: overrides.supersededCount ?? 0 };
      }),
    },
    prescription: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "prescription", op: "findFirst", args });
        return prescription;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "prescription", op: "update", args });
        return { id: RX_ID };
      }),
    },
    product: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "findFirst", args });
        return { id: PRODUCT_ID };
      }),
    },
    productAiGuardrail: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "productAiGuardrail", op: "findFirst", args });
        return guardrail;
      }),
    },
    order: {
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "update", args });
        return { id: ORDER_ID };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: overrides.orderUpdateManyCount ?? 1 };
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

function dataOf(call: FakeCall): Record<string, unknown> {
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
// Happy path
// ---------------------------------------------------------------------------

describe("AcceptTypingSuggestion — happy path", () => {
  it("writes the one field, resolves the suggestion, bumps the order, and audits", async () => {
    const fake = buildPrismaFake({ supersededCount: 1 });
    configureBus(fake.client);

    const out = await withTenancyContext(ctxFor(), () =>
      executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "accept-1" })
    );

    expect(out).toEqual({
      suggestionId: SUGGESTION_ID,
      prescriptionId: RX_ID,
      field: "refillsRemaining",
      fromVersion: 1,
      toVersion: 2,
      supersededSiblingCount: 1,
    });

    // Exactly one prescription column moves — never the whole draft.
    const rxUpdate = callsOf(fake.calls, "prescription", "update");
    expect(rxUpdate).toHaveLength(1);
    expect(dataOf(rxUpdate[0]!)).toEqual({ refillsRemaining: 8 });

    // The suggestion carries the actor stamp and the command_log id
    // that performed the write — that pair is what proves a human
    // accepted this, and which command did it.
    const resolved = dataOf(callsOf(fake.calls, "typingSuggestion", "update")[0]!);
    expect(resolved).toMatchObject({
      status: "ACCEPTED",
      resolvedByUserId: USER_ID,
    });
    expect(resolved["appliedCommandLogId"]).toBeDefined();

    // Order version CAS from the version the caller was shown.
    const cas = callsOf(fake.calls, "order", "updateMany");
    expect(cas).toHaveLength(1);
    expect((cas[0]!.args as { where: Record<string, unknown> }).where).toMatchObject({
      id: ORDER_ID,
      version: 1,
    });

    const audit = dataOf(callsOf(fake.calls, "auditLog", "create")[0]!);
    expect(audit["action"]).toBe("ai.typing_suggestion.accepted");
    expect(audit["metadata"]).toMatchObject({
      field: "refillsRemaining",
      valueBefore: 9,
      valueAfter: 8,
      source: "DETERMINISTIC",
    });

    const outbox = callsOf(fake.calls, "eventOutbox", "createMany")[0]!;
    expect((outbox.args as { data: Array<Record<string, unknown>> }).data[0]).toMatchObject({
      eventType: "ai.typing_suggestion.accepted.v1",
    });
  });

  it("supersedes sibling proposals for the same field only", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "accept-2" })
    );

    const where = (
      callsOf(fake.calls, "typingSuggestion", "updateMany")[0]!.args as {
        where: Record<string, unknown>;
      }
    ).where;
    expect(where).toMatchObject({
      organizationId: ORG_ID,
      prescriptionId: RX_ID,
      field: "refillsRemaining",
      status: "PROPOSED",
      id: { not: SUGGESTION_ID },
    });
  });

  it("writes a Decimal column through Prisma.Decimal, not a bare number", async () => {
    const fake = buildPrismaFake({
      suggestion: proposedSuggestion({
        field: "quantityAuthorized",
        currentValue: 60,
        suggestedValue: 90,
        findingCode: null,
        source: "MODEL",
        confidencePercent: 96,
      }),
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "accept-3" })
    );

    const written = dataOf(callsOf(fake.calls, "prescription", "update")[0]!);
    expect(Prisma.Decimal.isDecimal(written["quantityAuthorized"])).toBe(true);
    expect(String(written["quantityAuthorized"])).toBe("90");
  });
});

// ---------------------------------------------------------------------------
// Live re-checks — the reason this command exists
// ---------------------------------------------------------------------------

describe("AcceptTypingSuggestion — stale proposal", () => {
  it("refuses when the field moved after the proposal was generated", async () => {
    // Suggestion recorded refillsRemaining=9; a colleague has since
    // typed 4. The proposal is advice about a value that no longer
    // exists, so it is refused rather than applied over their edit.
    const fake = buildPrismaFake({
      prescription: prescriptionRow({ refillsRemaining: 4 }),
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "stale-1" })
      ).rejects.toMatchObject({ code: "TYPING_SUGGESTION_STALE" });
    });

    expect(callsOf(fake.calls, "prescription", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "typingSuggestion", "update")).toHaveLength(0);
    expect(callsOf(fake.calls, "order", "updateMany")).toHaveLength(0);
  });

  it("treats a null-to-null before-value as unchanged, not as a mismatch", async () => {
    // `earliestFillDate` was null at proposal time and is still null.
    // If the null round-trip were mishandled, every clear-the-field
    // proposal would read as stale and the fix could never be applied.
    const fake = buildPrismaFake({
      suggestion: proposedSuggestion({
        field: "earliestFillDate",
        currentValue: null,
        suggestedValue: "2026-09-01",
      }),
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "null-1" })
    );

    expect(dataOf(callsOf(fake.calls, "prescription", "update")[0]!)).toEqual({
      earliestFillDate: new Date("2026-09-01T00:00:00.000Z"),
    });
  });
});

describe("AcceptTypingSuggestion — live guardrail", () => {
  it("refuses a proposal that breaches a ceiling tightened after generation", async () => {
    // The run's snapshot allowed 8 refills; the tenant has since capped
    // the product at 3. The LIVE ceiling wins.
    const fake = buildPrismaFake({
      guardrail: {
        maxQuantityPerFill: null,
        maxDaysSupplyPerFill: null,
        maxRefillsAuthorized: 3,
        version: 7,
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "ceil-1" })
      ).rejects.toMatchObject({ code: "TYPING_SUGGESTION_GUARDRAIL_BREACH" });
    });

    expect(callsOf(fake.calls, "prescription", "update")).toHaveLength(0);
  });

  it("allows a proposal exactly at the live ceiling", async () => {
    const fake = buildPrismaFake({
      guardrail: {
        maxQuantityPerFill: null,
        maxDaysSupplyPerFill: null,
        maxRefillsAuthorized: 8,
        version: 7,
      },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "ceil-2" })
    );

    expect(callsOf(fake.calls, "prescription", "update")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// State + concurrency guards
// ---------------------------------------------------------------------------

describe("AcceptTypingSuggestion — state guard", () => {
  for (const status of ["TYPED_READY_FOR_PV1", "PV1_IN_PROGRESS", "ON_HOLD", "CANCELLED"]) {
    it(`refuses while the order is ${status}`, async () => {
      // Prescription edits belong to the typing stage, whose audit
      // shape covers them. Editing a draft a pharmacist is verifying
      // would change what they are approving underneath them.
      const fake = buildPrismaFake({ lockedRow: { currentStatus: status, version: 1 } });
      configureBus(fake.client);

      await withTenancyContext(ctxFor(), async () => {
        await expect(
          executeCommand(AcceptTypingSuggestion, validInput(), {
            idempotencyKey: `state-${status}`,
          })
        ).rejects.toMatchObject({ code: "TYPING_SUGGESTION_ORDER_NOT_IN_TYPING" });
      });

      expect(callsOf(fake.calls, "prescription", "update")).toHaveLength(0);
      // The state guard runs before the suggestion is even loaded.
      expect(callsOf(fake.calls, "typingSuggestion", "findFirst")).toHaveLength(0);
    });
  }
});

describe("AcceptTypingSuggestion — optimistic concurrency", () => {
  it("refuses when the caller's order version is behind", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "TYPING_IN_PROGRESS", version: 3 },
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "cas-1" })
      ).rejects.toMatchObject({ code: "ORDER_VERSION_MISMATCH" });
    });

    expect(callsOf(fake.calls, "prescription", "update")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suggestion lifecycle
// ---------------------------------------------------------------------------

describe("AcceptTypingSuggestion — suggestion lifecycle", () => {
  it("404s a suggestion that does not exist on this order", async () => {
    const fake = buildPrismaFake({ suggestion: null });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "nf-1" })
      ).rejects.toMatchObject({ code: "TYPING_SUGGESTION_NOT_FOUND" });
    });
  });

  it("scopes the suggestion lookup by org AND order", async () => {
    // Both scopes matter: org is the tenant boundary, order stops a
    // valid suggestion id from one order being applied via another.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), () =>
      executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "scope-1" })
    );

    expect(
      (callsOf(fake.calls, "typingSuggestion", "findFirst")[0]!.args as { where: unknown }).where
    ).toEqual({ id: SUGGESTION_ID, organizationId: ORG_ID, orderId: ORDER_ID });
  });

  for (const status of ["ACCEPTED", "DISMISSED", "SUPERSEDED"]) {
    it(`refuses a ${status} suggestion`, async () => {
      const fake = buildPrismaFake({ suggestion: proposedSuggestion({ status }) });
      configureBus(fake.client);

      await withTenancyContext(ctxFor(), async () => {
        await expect(
          executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: `life-${status}` })
        ).rejects.toMatchObject({ code: "TYPING_SUGGESTION_NOT_PROPOSED" });
      });

      expect(callsOf(fake.calls, "prescription", "update")).toHaveLength(0);
    });
  }

  it("refuses a stored value that no longer parses against the vocabulary", async () => {
    // Defense in depth against a row edited outside the command
    // surface: the vocabulary is re-checked at apply time, not trusted
    // from generation time.
    const fake = buildPrismaFake({
      suggestion: proposedSuggestion({ suggestedValue: 250 }),
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "vocab-1" })
      ).rejects.toMatchObject({ code: "TYPING_SUGGESTION_VALUE_INVALID" });
    });

    expect(callsOf(fake.calls, "prescription", "update")).toHaveLength(0);
  });

  it("refuses a field outside the vocabulary", async () => {
    const fake = buildPrismaFake({
      suggestion: proposedSuggestion({ field: "patientDateOfBirth" }),
    });
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "vocab-2" })
      ).rejects.toMatchObject({ code: "TYPING_SUGGESTION_VALUE_INVALID" });
    });

    expect(callsOf(fake.calls, "prescription", "update")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy + RBAC
// ---------------------------------------------------------------------------

describe("AcceptTypingSuggestion — tenancy + RBAC", () => {
  it("requires a tenancy context", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await expect(
      executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "t-1" })
    ).rejects.toMatchObject({ code: "TENANCY_NO_CONTEXT" });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });

  it("refuses a typist without the AI-assist grant, before any lock", async () => {
    // Typing permissions alone do NOT carry the AI panel: an org that
    // has not granted the assist permission cannot have proposals
    // applied by anyone, however senior.
    const fake = buildPrismaFake();
    configureBus(fake.client);

    resetRbacConfigurationForTests();
    configureRbac({
      loader: new InMemoryPermissionLoader([
        { organizationId: ORG_ID, userId: USER_ID, grants: typingOnlyGrants },
      ]),
    });

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AcceptTypingSuggestion, validInput(), { idempotencyKey: "rbac-1" })
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
    expect(callsOf(fake.calls, "prescription", "update")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("AcceptTypingSuggestion — input validation", () => {
  it("rejects a non-UUID suggestion id before any DB work", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          AcceptTypingSuggestion,
          { ...validInput(), suggestionId: "nope" },
          { idempotencyKey: "v-1" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });

    expect(callsOf(fake.calls, "$queryRaw", "select_for_update_order")).toHaveLength(0);
  });

  it("rejects extra fields under the strict schema", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(AcceptTypingSuggestion, { ...validInput(), override: true } as never, {
          idempotencyKey: "v-2",
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("requires expectedOrderVersion", async () => {
    const fake = buildPrismaFake();
    configureBus(fake.client);

    await withTenancyContext(ctxFor(), async () => {
      await expect(
        executeCommand(
          AcceptTypingSuggestion,
          { orderId: ORDER_ID, suggestionId: SUGGESTION_ID } as never,
          { idempotencyKey: "v-3" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});
