// RecordCompoundingPreparation contract tests (ADR-0035 slice 2).
//
// Invariants under test:
//   1. Fill-stage guards: order must be FILL_IN_PROGRESS and assigned
//      to the actor (same codes as AssignLot).
//   2. Only an ACTIVE formula version may be prepared; the record pins
//      formula id + code + version and the order's workflow policy.
//   3. Consumptions must cover the recipe exactly; product-backed
//      ingredients need a guarded Lot (site/status/expiry/product),
//      bulk chemicals need a manual lot number.
//   4. BUD = preparedAt + budDays, clamped to the earliest component
//      expiration.
//   5. One COMPOUND_CONSUMED inventory deduction per consumed lot.
//   6. Hazardous formulas require handling notes; FAIL requires
//      quality notes.
//   7. The rendered document is stored in-row with a matching sha-256
//      and stays out of audit metadata and the outbox payload.
//   8. RBAC denial before any domain write.

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { LotStatus, RoleScope } from "@pharmax/database";
import { FILL_NOT_ASSIGNED_TO_ACTOR, FILL_WRONG_STATUS } from "@pharmax/fill";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import {
  COMPOUND_FORMULA_INVALID_STATE,
  COMPOUNDING_HANDLING_NOTES_REQUIRED,
  COMPOUNDING_INGREDIENT_LOT_REQUIRED,
  COMPOUNDING_INGREDIENT_MANUAL_LOT_REQUIRED,
  COMPOUNDING_INGREDIENT_MISMATCH,
  COMPOUNDING_LOT_EXPIRED,
  COMPOUNDING_LOT_PRODUCT_MISMATCH,
  COMPOUNDING_QUALITY_NOTES_REQUIRED,
} from "../shared.js";
import { RecordCompoundingPreparation } from "./record-compounding-preparation.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORDER_LINE_ID = "00000000-0000-4000-8000-0000000000bb";
const USER_ID = "00000000-0000-4000-8000-000000000009";
const POLICY_ID = "00000000-0000-4000-8000-000000000008";
const FORMULA_ID = "00000000-0000-4000-8000-0000000000f0";
const INGREDIENT_PRODUCT_BACKED_ID = "00000000-0000-4000-8000-0000000000f1";
const INGREDIENT_MANUAL_ID = "00000000-0000-4000-8000-0000000000f2";
const PRODUCT_ID = "00000000-0000-4000-8000-0000000000d0";
const LOT_ID = "00000000-0000-4000-8000-0000000000cc";

// Frozen clock for every test: preparedAt is deterministic.
const NOW = new Date("2026-08-01T12:00:00.000Z");

const prepareGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.COMPOUNDING_PREPARE]),
  },
];

const readOnlyGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.COMPOUNDING_READ]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

function validInput() {
  return {
    orderId: ORDER_ID,
    orderLineId: ORDER_LINE_ID,
    formulaId: FORMULA_ID,
    consumptions: [
      { formulaIngredientId: INGREDIENT_PRODUCT_BACKED_ID, lotId: LOT_ID, quantity: 80 },
      {
        formulaIngredientId: INGREDIENT_MANUAL_ID,
        manualLotNumber: "BULK-77",
        manualExpirationDate: "2027-01-31",
        quantity: 40,
      },
    ],
    qualityOutcome: "PASS" as const,
  };
}

interface FormulaIngredientRow {
  id: string;
  productId: string | null;
  ingredientName: string;
  quantity: unknown;
  unit: string;
  sortOrder: number;
}

function defaultFormulaRow() {
  return {
    id: FORMULA_ID,
    organizationId: ORG_ID,
    code: "MAGIC-MOUTHWASH",
    version: 3,
    status: "ACTIVE",
    name: "Magic Mouthwash Suspension",
    preparationKind: "NONSTERILE",
    hazardous: false,
    budDays: 14,
    storageCondition: "REFRIGERATED",
    ingredients: [
      {
        id: INGREDIENT_PRODUCT_BACKED_ID,
        productId: PRODUCT_ID,
        ingredientName: "Diphenhydramine 12.5mg/5mL",
        quantity: 80,
        unit: "mL",
        sortOrder: 0,
      },
      {
        id: INGREDIENT_MANUAL_ID,
        productId: null,
        ingredientName: "Lidocaine viscous 2%",
        quantity: 40,
        unit: "mL",
        sortOrder: 1,
      },
    ] satisfies FormulaIngredientRow[],
  };
}

function defaultLotRow() {
  return {
    id: LOT_ID,
    siteId: SITE_ID,
    productId: PRODUCT_ID,
    lotNumber: "LOT-A1",
    expirationDate: new Date("2027-12-31T00:00:00.000Z"),
    status: LotStatus.ACTIVE,
  };
}

// ---------------------------------------------------------------------
// Fake Prisma
// ---------------------------------------------------------------------

interface FakeCall {
  readonly table: string;
  readonly op: string;
  readonly args: unknown;
}

interface FakeOverrides {
  lockedRow?: { currentStatus: string; version: number } | null;
  assigneeUserId?: string | null;
  orderLine?: Record<string, unknown> | null;
  formulaRow?: Record<string, unknown> | null;
  lotRow?: Record<string, unknown> | null;
}

function buildPrismaFake(overrides: FakeOverrides = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const lockedRow =
    overrides.lockedRow === undefined
      ? { currentStatus: "FILL_IN_PROGRESS", version: 5 }
      : overrides.lockedRow;
  const assigneeUserId =
    overrides.assigneeUserId === undefined ? USER_ID : overrides.assigneeUserId;
  const orderLine =
    overrides.orderLine === undefined
      ? { id: ORDER_LINE_ID, prescription: { rxNumber: "RX-100200" } }
      : overrides.orderLine;
  const formulaRow =
    overrides.formulaRow === undefined ? defaultFormulaRow() : overrides.formulaRow;
  const lotRow = overrides.lotRow === undefined ? defaultLotRow() : overrides.lotRow;

  const tx = {
    workflowPolicy: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "workflowPolicy", op: "findUnique", args });
        return { id: POLICY_ID, code: "order.standard", version: 1, status: "ACTIVE" };
      }),
    },
    order: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "findFirst", args });
        return { currentAssigneeUserId: assigneeUserId };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "order", op: "updateMany", args });
        return { count: 1 };
      }),
    },
    orderLine: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderLine", op: "findFirst", args });
        return orderLine;
      }),
    },
    compoundFormula: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundFormula", op: "findFirst", args });
        return formulaRow;
      }),
    },
    lot: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "lot", op: "findFirst", args });
        return lotRow;
      }),
    },
    inventoryTransaction: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "inventoryTransaction", op: "create", args });
        return { id: "it-1" };
      }),
    },
    compoundingRecord: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundingRecord", op: "create", args });
        return { id: (args as { data: { id: string } }).data.id };
      }),
    },
    compoundingRecordIngredient: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundingRecordIngredient", op: "createMany", args });
        return { count: (args as { data: unknown[] }).data.length };
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "findFirst", args });
        return { sequenceNumber: 5 };
      }),
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "orderEvent", op: "create", args });
        return { id: "oe-6" };
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
      const op =
        /\bFROM\s+"?order"?\b/i.test(joined) && /\bFOR\s+UPDATE\b/i.test(joined)
          ? "select_for_update_order"
          : "raw";
      calls.push({ table: "$queryRaw", op, args: { sql: joined, values: [...values] } });
      if (op === "select_for_update_order") {
        return lockedRow === null
          ? []
          : [
              {
                id: ORDER_ID,
                organizationId: ORG_ID,
                siteId: SITE_ID,
                currentStatus: lockedRow.currentStatus,
                version: lockedRow.version,
                workflowPolicyId: POLICY_ID,
                workflowPolicyVersion: 1,
              },
            ];
      }
      return [];
    }),
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        calls.push({
          table: "$executeRaw",
          op: "set_config",
          args: { sql: template.join("?"), values: [...values] },
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

function findOnly(calls: FakeCall[], table: string, op: string): FakeCall {
  const m = callsOf(calls, table, op);
  if (m.length !== 1) {
    throw new Error(`Expected exactly one ${table}.${op}, got ${m.length}`);
  }
  return m[0] as FakeCall;
}

function wireBusAndRbac(
  client: unknown,
  grants: ReadonlyArray<ResolvedGrant> = prepareGrants
): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(NOW),
    logger: logger.noopLogger,
  });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
}

function run(input: unknown, key = "prep-1") {
  return withTenancyContext(ctx(), () =>
    executeCommand(RecordCompoundingPreparation, input as Parameters<typeof executeCommand>[1], {
      idempotencyKey: key,
    })
  );
}

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ---------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------

describe("RecordCompoundingPreparation — happy path", () => {
  it("writes the record with pinned formula + policy, ledger deduction, and the rendered document", async () => {
    const fake = buildPrismaFake();
    wireBusAndRbac(fake.client);

    const out = await run(validInput());

    expect(out).toMatchObject({
      orderId: ORDER_ID,
      orderLineId: ORDER_LINE_ID,
      formulaId: FORMULA_ID,
      formulaCode: "MAGIC-MOUTHWASH",
      formulaVersion: 3,
      qualityOutcome: "PASS",
      version: 6,
    });
    // budDays 14, no earlier component expiration → NOW + 14 days.
    expect(out.budAt).toBe("2026-08-15T12:00:00.000Z");

    const record = (
      findOnly(fake.calls, "compoundingRecord", "create").args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(record).toMatchObject({
      organizationId: ORG_ID,
      orderId: ORDER_ID,
      orderLineId: ORDER_LINE_ID,
      formulaId: FORMULA_ID,
      formulaCode: "MAGIC-MOUTHWASH",
      formulaVersion: 3,
      preparedByUserId: USER_ID,
      storageCondition: "REFRIGERATED",
      hazardous: false,
      qualityOutcome: "PASS",
      workflowPolicyId: POLICY_ID,
      workflowPolicyVersion: 1,
    });

    // Rendered document: atomic with the record, hash matches, and it
    // actually documents the preparation.
    const rendered = record["renderedDocument"] as string;
    expect(rendered).toContain("MAGIC-MOUTHWASH v3");
    expect(rendered).toContain("LOT-A1");
    expect(rendered).toContain("BULK-77");
    expect(rendered).toContain("RX-100200");
    const sha = record["documentSha256"] as Buffer;
    expect(Buffer.compare(sha, createHash("sha256").update(rendered, "utf8").digest())).toBe(0);

    // Ingredient rows: lot FK for the product-backed one, manual lot
    // for the bulk chemical, recipe order preserved.
    const ingredientRows = (
      findOnly(fake.calls, "compoundingRecordIngredient", "createMany").args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(ingredientRows).toHaveLength(2);
    expect(ingredientRows[0]).toMatchObject({
      formulaIngredientId: INGREDIENT_PRODUCT_BACKED_ID,
      lotId: LOT_ID,
      sortOrder: 0,
      unit: "mL",
    });
    expect(ingredientRows[0]).not.toHaveProperty("manualLotNumber");
    expect(ingredientRows[1]).toMatchObject({
      formulaIngredientId: INGREDIENT_MANUAL_ID,
      manualLotNumber: "BULK-77",
      sortOrder: 1,
    });
    expect(ingredientRows[1]).not.toHaveProperty("lotId");

    // Exactly one ledger deduction (the product-backed lot).
    const ledger = callsOf(fake.calls, "inventoryTransaction", "create");
    expect(ledger).toHaveLength(1);
    const ledgerData = (ledger[0]?.args as { data: Record<string, unknown> }).data;
    expect(ledgerData).toMatchObject({
      organizationId: ORG_ID,
      lotId: LOT_ID,
      orderLineId: ORDER_LINE_ID,
      reason: "COMPOUND_CONSUMED",
    });
    expect(String(ledgerData["quantityDelta"])).toBe("-80");

    // Version CAS 5 → 6.
    const bump = findOnly(fake.calls, "order", "updateMany").args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(bump.where).toMatchObject({ id: ORDER_ID, version: 5 });
    expect(bump.data).toMatchObject({ version: 6 });

    // Outbox event: ids + recipe identity + consumed lots; no rendered
    // document, no notes.
    const outbox = (
      findOnly(fake.calls, "eventOutbox", "createMany").args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(outbox).toHaveLength(1);
    const payload = outbox[0]?.["payload"] as Record<string, unknown>;
    expect(outbox[0]).toMatchObject({ eventType: "compounding.preparation.recorded.v1" });
    expect(payload).toMatchObject({
      compoundingRecordId: out.compoundingRecordId,
      formulaCode: "MAGIC-MOUTHWASH",
      formulaVersion: 3,
      qualityOutcome: "PASS",
      consumedLotIds: [LOT_ID],
    });
    expect(JSON.stringify(payload)).not.toContain("RX-100200");

    // Audit metadata carries identity, not content.
    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { action: string; metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.action).toBe("compounding.preparation.recorded");
    expect(audit.metadata).toMatchObject({
      formulaCode: "MAGIC-MOUTHWASH",
      qualityOutcome: "PASS",
      consumedLotIds: [LOT_ID],
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("RX-100200");
  });

  it("clamps the BUD to the earliest component expiration", async () => {
    const fake = buildPrismaFake({
      lotRow: { ...defaultLotRow(), expirationDate: new Date("2026-08-05T00:00:00.000Z") },
    });
    wireBusAndRbac(fake.client);

    const out = await run(validInput());

    // Lot expires before NOW + 14 days → clamped.
    expect(out.budAt).toBe("2026-08-05T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------
// Fill-stage guards
// ---------------------------------------------------------------------

describe("RecordCompoundingPreparation — fill-stage guards", () => {
  it("rejects when the order is not FILL_IN_PROGRESS", async () => {
    const fake = buildPrismaFake({
      lockedRow: { currentStatus: "PV1_IN_PROGRESS", version: 5 },
    });
    wireBusAndRbac(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({ code: FILL_WRONG_STATUS });
    expect(callsOf(fake.calls, "compoundingRecord", "create")).toHaveLength(0);
  });

  it("rejects when the order is assigned to someone else", async () => {
    const fake = buildPrismaFake({ assigneeUserId: "00000000-0000-4000-8000-00000000000e" });
    wireBusAndRbac(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: FILL_NOT_ASSIGNED_TO_ACTOR,
    });
    expect(callsOf(fake.calls, "compoundingRecord", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Formula + consumption guards
// ---------------------------------------------------------------------

describe("RecordCompoundingPreparation — formula and consumption guards", () => {
  it("rejects a non-ACTIVE formula version", async () => {
    const fake = buildPrismaFake({
      formulaRow: { ...defaultFormulaRow(), status: "DRAFT" },
    });
    wireBusAndRbac(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: COMPOUND_FORMULA_INVALID_STATE,
    });
  });

  it("rejects consumptions that do not cover the recipe exactly", async () => {
    const fake = buildPrismaFake();
    wireBusAndRbac(fake.client);

    const input = validInput();
    input.consumptions = [input.consumptions[0]!]; // second ingredient missing

    await expect(run(input)).rejects.toMatchObject({
      code: COMPOUNDING_INGREDIENT_MISMATCH,
    });
    expect(callsOf(fake.calls, "inventoryTransaction", "create")).toHaveLength(0);
  });

  it("requires a lotId for a product-backed ingredient", async () => {
    const fake = buildPrismaFake();
    wireBusAndRbac(fake.client);

    const input = validInput();
    input.consumptions[0] = {
      formulaIngredientId: INGREDIENT_PRODUCT_BACKED_ID,
      quantity: 80,
    } as (typeof input.consumptions)[0];

    await expect(run(input)).rejects.toMatchObject({
      code: COMPOUNDING_INGREDIENT_LOT_REQUIRED,
    });
  });

  it("requires a manual lot number for an ingredient without a catalog product", async () => {
    const fake = buildPrismaFake();
    wireBusAndRbac(fake.client);

    const input = validInput();
    input.consumptions[1] = {
      formulaIngredientId: INGREDIENT_MANUAL_ID,
      quantity: 40,
    } as (typeof input.consumptions)[1];

    await expect(run(input)).rejects.toMatchObject({
      code: COMPOUNDING_INGREDIENT_MANUAL_LOT_REQUIRED,
    });
  });

  it("rejects a lot of the wrong product", async () => {
    const fake = buildPrismaFake({
      lotRow: { ...defaultLotRow(), productId: "00000000-0000-4000-8000-0000000000d9" },
    });
    wireBusAndRbac(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: COMPOUNDING_LOT_PRODUCT_MISMATCH,
    });
    expect(callsOf(fake.calls, "inventoryTransaction", "create")).toHaveLength(0);
  });

  it("rejects an expired ingredient lot", async () => {
    const fake = buildPrismaFake({
      lotRow: { ...defaultLotRow(), expirationDate: new Date("2026-07-31T00:00:00.000Z") },
    });
    wireBusAndRbac(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({ code: COMPOUNDING_LOT_EXPIRED });
  });

  it("rejects an expired manually documented component", async () => {
    const fake = buildPrismaFake();
    wireBusAndRbac(fake.client);

    const input = validInput();
    input.consumptions[1] = {
      formulaIngredientId: INGREDIENT_MANUAL_ID,
      manualLotNumber: "BULK-77",
      manualExpirationDate: "2026-07-30",
      quantity: 40,
    };

    await expect(run(input)).rejects.toMatchObject({ code: COMPOUNDING_LOT_EXPIRED });
  });
});

// ---------------------------------------------------------------------
// Documentation requirements
// ---------------------------------------------------------------------

describe("RecordCompoundingPreparation — documentation requirements", () => {
  it("requires handling notes for a hazardous formula", async () => {
    const fake = buildPrismaFake({
      formulaRow: { ...defaultFormulaRow(), hazardous: true },
    });
    wireBusAndRbac(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: COMPOUNDING_HANDLING_NOTES_REQUIRED,
    });

    const withNotes = { ...validInput(), handlingNotes: "Prepared in CVE with double gloves." };
    const out = await run(withNotes, "prep-2");
    expect(out.compoundingRecordId).toBeTruthy();
  });

  it("requires quality notes on a FAIL outcome and records the failure", async () => {
    const fake = buildPrismaFake();
    wireBusAndRbac(fake.client);

    await expect(run({ ...validInput(), qualityOutcome: "FAIL" })).rejects.toMatchObject({
      code: COMPOUNDING_QUALITY_NOTES_REQUIRED,
    });

    const out = await run(
      { ...validInput(), qualityOutcome: "FAIL", qualityNotes: "Visible precipitate; discarded." },
      "prep-3"
    );
    expect(out.qualityOutcome).toBe("FAIL");
    const record = (
      findOnly(fake.calls, "compoundingRecord", "create").args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(record).toMatchObject({
      qualityOutcome: "FAIL",
      qualityNotes: "Visible precipitate; discarded.",
    });
  });
});

// ---------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------

describe("RecordCompoundingPreparation — RBAC", () => {
  it("denies an actor without compounding.prepare before any domain write", async () => {
    const fake = buildPrismaFake();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await expect(run(validInput())).rejects.toMatchObject({ name: "AuthorizationError" });
    expect(callsOf(fake.calls, "compoundingRecord", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "inventoryTransaction", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});
