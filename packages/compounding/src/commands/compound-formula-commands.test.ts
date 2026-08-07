// Contract tests for the compound-formula lifecycle commands
// (ADR-0035, slice 1).
//
// Invariants under test:
//   1. Create drafts version MAX+1, writes ingredient child rows with
//      stable sortOrder, and keeps the recipe OUT of audit/outbox
//      (identity + count only).
//   2. BUD guards: USP <795> hard caps per basis; STABILITY_STUDY
//      requires a budReference.
//   3. Ingredient productIds must resolve in THIS org's catalog —
//      typed NotFound, not an opaque FK failure.
//   4. Concurrent-draft protection: P2002 is translated to a typed
//      COMPOUND_FORMULA_DRAFT_EXISTS conflict.
//   5. Publish is status-guarded (DRAFT only) and retires the
//      previously ACTIVE version of the same code in the same
//      transaction, with the supersede recorded in the event.
//   6. Retire is status-guarded (ACTIVE only) and always carries a
//      closed reason code.
//   7. RBAC denial leaves zero command_log footprint.

import { afterEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { RoleScope } from "@pharmax/database";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { CreateCompoundFormula } from "./create-compound-formula.js";
import { PublishCompoundFormula } from "./publish-compound-formula.js";
import { RetireCompoundFormula } from "./retire-compound-formula.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const FORMULA_ID = "44444444-4444-4444-8444-444444444444";
const PREDECESSOR_ID = "55555555-5555-4555-8555-555555555555";
const PRODUCT_ID = "66666666-6666-4666-8666-666666666666";

const managerGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.COMPOUNDING_FORMULA_MANAGE, PERMISSIONS.COMPOUNDING_READ]),
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

function validCreateInput() {
  return {
    code: "MAGIC-MOUTHWASH",
    name: "Magic Mouthwash Suspension",
    preparationKind: "NONSTERILE" as const,
    budDays: 14,
    budBasis: "USP795_AQUEOUS_NONPRESERVED" as const,
    storageCondition: "REFRIGERATED" as const,
    instructions: "Combine per procedure; shake well.",
    ingredients: [
      {
        productId: PRODUCT_ID,
        ingredientName: "Diphenhydramine 12.5mg/5mL",
        quantity: 80,
        unit: "mL",
      },
      { ingredientName: "Lidocaine viscous 2%", quantity: 80, unit: "mL" },
    ],
  };
}

// ---------------------------------------------------------------------
// Fake Prisma
// ---------------------------------------------------------------------

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakePrismaOptions {
  /** Row returned by compoundFormula.findUnique (publish/retire). */
  formulaRow?: {
    id: string;
    code: string;
    version: number;
    status: string;
  } | null;
  /** Row returned by the ACTIVE-predecessor findFirst (publish). */
  activePredecessor?: { id: string; version: number } | null;
  /** Row returned by the MAX(version) findFirst (create). */
  latestVersion?: { version: number } | null;
  /** Product ids that exist in the org catalog. Default: all requested. */
  knownProductIds?: ReadonlyArray<string>;
  /** When set, compoundFormula.create throws this. */
  formulaCreateError?: Error;
  /** Row returned by product.findFirst (compoundProductId validation). */
  compoundProductRow?: { id: string; ndcKind: string } | null;
  /** When set, compoundFormula.update throws this (publish conflict). */
  formulaUpdateError?: Error;
}

function buildFakePrisma(opts: FakePrismaOptions = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const tx = {
    compoundFormula: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundFormula", op: "create", args });
        if (opts.formulaCreateError !== undefined) throw opts.formulaCreateError;
        return (args as { data: { id: string } }).data;
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundFormula", op: "findUnique", args });
        return opts.formulaRow ?? null;
      }),
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundFormula", op: "findFirst", args });
        const where = (args as { where: Record<string, unknown> }).where;
        if (where["status"] === "ACTIVE") return opts.activePredecessor ?? null;
        return opts.latestVersion ?? null;
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundFormula", op: "update", args });
        if (opts.formulaUpdateError !== undefined) throw opts.formulaUpdateError;
        return { id: (args as { where: { id: string } }).where.id };
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundFormula", op: "updateMany", args });
        return { count: 1 };
      }),
    },
    compoundFormulaIngredient: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "compoundFormulaIngredient", op: "createMany", args });
        const data = (args as { data: unknown[] }).data;
        return { count: data.length };
      }),
    },
    product: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "findMany", args });
        const requested = (args as { where: { id: { in: string[] } } }).where.id.in;
        const known = opts.knownProductIds === undefined ? requested : opts.knownProductIds;
        return requested.filter((id) => known.includes(id)).map((id) => ({ id }));
      }),
      findFirst: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "findFirst", args });
        return opts.compoundProductRow ?? null;
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cmd-log-1" };
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
        return { id: "audit-1" };
      }),
    },
    auditChainState: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "findUnique", args });
        return null;
      }),
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "auditChainState", op: "upsert", args });
        const data = args as {
          where: { organizationId: string };
          create: { latestHash: Buffer; latestSeq: bigint };
        };
        return {
          organizationId: data.where.organizationId,
          latestHash: data.create.latestHash,
          latestSeq: data.create.latestSeq,
        };
      }),
    },
    eventOutbox: {
      createMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "eventOutbox", op: "createMany", args });
        const data = (args as { data: unknown[] }).data;
        return { count: data.length };
      }),
    },
    idempotencyKey: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "create", args });
        return { id: "idem-1" };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "idempotencyKey", op: "findUnique", args });
        return null;
      }),
    },
    $executeRaw: vi.fn(
      async (template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
        const joined = template.join("?");
        const op = /\bset_config\b/i.test(joined)
          ? "set_config"
          : /\bpg_advisory_xact_lock\b/i.test(joined)
            ? "advisory_lock"
            : "raw";
        calls.push({ table: "$executeRaw", op, args: { sql: joined, values: [...values] } });
        return 0;
      }
    ),
  };

  const client = {
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cmd-log-pretx" };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "update", args });
        return { id: "cmd-log-pretx" };
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

function outboxPayloads(calls: FakeCall[]): Array<Record<string, unknown>> {
  return callsOf(calls, "eventOutbox", "createMany").flatMap(
    (c) => (c.args as { data: Array<Record<string, unknown>> }).data
  );
}

function wireBusAndRbac(
  client: unknown,
  grants: ReadonlyArray<ResolvedGrant> = managerGrants
): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-08-01T12:00:00.000Z")),
    logger: logger.noopLogger,
  });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
}

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
});

// ---------------------------------------------------------------------
// CreateCompoundFormula
// ---------------------------------------------------------------------

describe("CreateCompoundFormula — happy path", () => {
  it("drafts version 1 with ingredient rows in order and emits the created event", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateCompoundFormula, validCreateInput(), { idempotencyKey: "create-1" })
    );

    expect(out.version).toBe(1);
    expect(out.code).toBe("MAGIC-MOUTHWASH");

    const formula = (
      findOnly(fake.calls, "compoundFormula", "create").args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(formula).toMatchObject({
      id: out.formulaId,
      organizationId: ORG_ID,
      code: "MAGIC-MOUTHWASH",
      version: 1,
      status: "DRAFT",
      preparationKind: "NONSTERILE",
      hazardous: false,
      budDays: 14,
      budBasis: "USP795_AQUEOUS_NONPRESERVED",
      storageCondition: "REFRIGERATED",
      createdByUserId: USER_ID,
    });

    const ingredients = (
      findOnly(fake.calls, "compoundFormulaIngredient", "createMany").args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(ingredients).toHaveLength(2);
    expect(ingredients[0]).toMatchObject({
      organizationId: ORG_ID,
      formulaId: out.formulaId,
      productId: PRODUCT_ID,
      ingredientName: "Diphenhydramine 12.5mg/5mL",
      unit: "mL",
      sortOrder: 0,
    });
    expect(ingredients[1]).toMatchObject({
      ingredientName: "Lidocaine viscous 2%",
      sortOrder: 1,
    });
    expect(ingredients[1]?.["productId"]).toBeUndefined();

    const events = outboxPayloads(fake.calls);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "compounding.formula.created.v1" });
    const payload = events[0]?.["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({
      formulaId: out.formulaId,
      organizationId: ORG_ID,
      code: "MAGIC-MOUTHWASH",
      version: 1,
      preparationKind: "NONSTERILE",
      hazardous: false,
    });
    // The recipe stays out of the event.
    expect(payload["ingredients"]).toBeUndefined();

    // Audit carries identity + count, never the recipe.
    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.metadata).toMatchObject({ code: "MAGIC-MOUTHWASH", ingredientCount: 2 });
    expect(JSON.stringify(audit.metadata)).not.toContain("Lidocaine");
  });

  it("drafts version MAX+1 when prior versions of the code exist", async () => {
    const fake = buildFakePrisma({ latestVersion: { version: 3 } });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateCompoundFormula, validCreateInput(), { idempotencyKey: "create-2" })
    );

    expect(out.version).toBe(4);
  });
});

describe("CreateCompoundFormula — BUD guards", () => {
  it("rejects budDays above the USP <795> cap for the basis", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundFormula,
          { ...validCreateInput(), budDays: 15 },
          { idempotencyKey: "bud-cap" }
        )
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_BUD_EXCEEDS_BASIS" });

    expect(callsOf(fake.calls, "compoundFormula", "create")).toHaveLength(0);
  });

  it("accepts budDays at the exact cap", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateCompoundFormula,
        { ...validCreateInput(), budDays: 14 },
        { idempotencyKey: "bud-at-cap" }
      )
    );
    expect(out.version).toBe(1);
  });

  it("requires budReference for STABILITY_STUDY", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundFormula,
          { ...validCreateInput(), budBasis: "STABILITY_STUDY" as const, budDays: 180 },
          { idempotencyKey: "bud-ref" }
        )
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_BUD_REFERENCE_REQUIRED" });

    expect(callsOf(fake.calls, "compoundFormula", "create")).toHaveLength(0);
  });

  it("allows a long BUD under STABILITY_STUDY when the reference is supplied", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateCompoundFormula,
        {
          ...validCreateInput(),
          budBasis: "STABILITY_STUDY" as const,
          budDays: 180,
          budReference: "Smith et al., IJPC 2024;28(2):142-149",
        },
        { idempotencyKey: "bud-ref-ok" }
      )
    );
    expect(out.version).toBe(1);
  });

  it("rejects a basis that does not match the preparation kind", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    // A STERILE prep cannot justify its BUD from a <795> basis.
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundFormula,
          { ...validCreateInput(), preparationKind: "STERILE" as const },
          { idempotencyKey: "basis-kind" }
        )
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_BUD_BASIS_MISMATCH" });

    expect(callsOf(fake.calls, "compoundFormula", "create")).toHaveLength(0);
  });

  it("enforces the USP <797> category outer bounds", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    // Category 2's outer bound is 45 days.
    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundFormula,
          {
            ...validCreateInput(),
            preparationKind: "STERILE" as const,
            budBasis: "USP797_CATEGORY_2" as const,
            budDays: 60,
          },
          { idempotencyKey: "797-cap" }
        )
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_BUD_EXCEEDS_BASIS" });

    // At the bound it drafts fine.
    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateCompoundFormula,
        {
          ...validCreateInput(),
          preparationKind: "STERILE" as const,
          budBasis: "USP797_CATEGORY_2" as const,
          budDays: 45,
        },
        { idempotencyKey: "797-at-cap" }
      )
    );
    expect(out.version).toBe(1);
  });
});

describe("CreateCompoundFormula — ingredient product validation", () => {
  it("rejects productIds missing from the org catalog with a typed NotFound", async () => {
    const fake = buildFakePrisma({ knownProductIds: [] });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundFormula, validCreateInput(), { idempotencyKey: "bad-prod" })
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_INGREDIENT_PRODUCT_NOT_FOUND" });

    // The lookup was org-scoped.
    const lookup = findOnly(fake.calls, "product", "findMany");
    expect((lookup.args as { where: { organizationId: string } }).where.organizationId).toBe(
      ORG_ID
    );
    expect(callsOf(fake.calls, "compoundFormula", "create")).toHaveLength(0);
  });

  it("skips the catalog lookup when no ingredient references a product", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        CreateCompoundFormula,
        {
          ...validCreateInput(),
          ingredients: [{ ingredientName: "Simple syrup", quantity: 120, unit: "mL" }],
        },
        { idempotencyKey: "no-prod" }
      )
    );

    expect(callsOf(fake.calls, "product", "findMany")).toHaveLength(0);
  });
});

describe("CreateCompoundFormula — ingredient coding and the compound-product link", () => {
  const COMPOUND_PRODUCT_ID = "77777777-7777-4777-8777-777777777777";

  function codedCreateInput() {
    return {
      ...validCreateInput(),
      compoundProductId: COMPOUND_PRODUCT_ID,
      ingredients: [
        {
          ingredientName: "FIXTURE-ACTIVE-A",
          quantity: 80,
          unit: "mL",
          rxnormInRxcui: "900001",
        },
        { ingredientName: "FIXTURE-MYSTERY", quantity: 80, unit: "mL" },
        {
          ingredientName: "FIXTURE-BASE",
          quantity: 40,
          unit: "mL",
          noRxnormIngredient: true,
        },
      ],
    };
  }

  it("persists the per-row coding state and the product link, and audits the counts", async () => {
    const fake = buildFakePrisma({
      compoundProductRow: { id: COMPOUND_PRODUCT_ID, ndcKind: "IN_HOUSE_COMPOUND" },
    });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(CreateCompoundFormula, codedCreateInput(), { idempotencyKey: "coded-1" })
    );

    const formula = (
      findOnly(fake.calls, "compoundFormula", "create").args as { data: Record<string, unknown> }
    ).data;
    expect(formula).toMatchObject({ id: out.formulaId, compoundProductId: COMPOUND_PRODUCT_ID });

    const ingredients = (
      findOnly(fake.calls, "compoundFormulaIngredient", "createMany").args as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(ingredients[0]).toMatchObject({ coding: "RXNORM_IN", rxnormInRxcui: "900001" });
    expect(ingredients[1]).toMatchObject({ coding: "UNCODED" });
    expect(ingredients[1]?.["rxnormInRxcui"]).toBeUndefined();
    expect(ingredients[2]).toMatchObject({ coding: "NO_RXNORM_INGREDIENT" });
    expect(ingredients[2]?.["rxnormInRxcui"]).toBeUndefined();

    // The screening-relevant facts reach the audit record as counts —
    // the recipe itself stays out, as ever.
    const audit = (
      findOnly(fake.calls, "auditLog", "create").args as {
        data: { metadata: Record<string, unknown> };
      }
    ).data;
    expect(audit.metadata).toMatchObject({
      codedIngredientCount: 1,
      uncodedIngredientCount: 1,
      compoundProductId: COMPOUND_PRODUCT_ID,
    });
  });

  it("rejects a row that both carries an RXCUI and asserts none applies, at the schema boundary", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundFormula,
          {
            ...validCreateInput(),
            ingredients: [
              {
                ingredientName: "FIXTURE-CONTRADICTION",
                quantity: 1,
                unit: "g",
                rxnormInRxcui: "900001",
                noRxnormIngredient: true,
              },
            ],
          },
          { idempotencyKey: "both" }
        )
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(callsOf(fake.calls, "compoundFormula", "create")).toHaveLength(0);
  });

  it("rejects a non-numeric RXCUI at the schema boundary", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          CreateCompoundFormula,
          {
            ...validCreateInput(),
            ingredients: [
              { ingredientName: "FIXTURE-BAD", quantity: 1, unit: "g", rxnormInRxcui: "RX-1" },
            ],
          },
          { idempotencyKey: "bad-rxcui" }
        )
      )
    ).rejects.toMatchObject({ name: "ValidationError" });
  });

  it("refuses a compoundProductId missing from this org's catalog", async () => {
    const fake = buildFakePrisma({ compoundProductRow: null });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundFormula, codedCreateInput(), { idempotencyKey: "no-prod-2" })
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_PRODUCT_NOT_FOUND" });
    expect(callsOf(fake.calls, "compoundFormula", "create")).toHaveLength(0);
  });

  it("refuses to link a NATIONAL product — the screening-suppression vector", async () => {
    // Linking a real NDC to an org-authored recipe would replace its
    // published-nomenclature screening with whatever the org wrote.
    const fake = buildFakePrisma({
      compoundProductRow: { id: COMPOUND_PRODUCT_ID, ndcKind: "NATIONAL" },
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundFormula, codedCreateInput(), { idempotencyKey: "national" })
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_PRODUCT_NOT_COMPOUND" });
    expect(callsOf(fake.calls, "compoundFormula", "create")).toHaveLength(0);
  });
});

describe("CreateCompoundFormula — concurrent draft", () => {
  it("translates the partial-unique P2002 into a typed conflict", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique violation", {
      code: "P2002",
      clientVersion: "test",
    });
    const fake = buildFakePrisma({ formulaCreateError: p2002 });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundFormula, validCreateInput(), { idempotencyKey: "dup-draft" })
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_DRAFT_EXISTS" });

    expect(callsOf(fake.calls, "compoundFormulaIngredient", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// PublishCompoundFormula
// ---------------------------------------------------------------------

describe("PublishCompoundFormula", () => {
  it("activates the draft and retires the ACTIVE predecessor in the same transaction", async () => {
    const fake = buildFakePrisma({
      formulaRow: { id: FORMULA_ID, code: "MAGIC-MOUTHWASH", version: 2, status: "DRAFT" },
      activePredecessor: { id: PREDECESSOR_ID, version: 1 },
    });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(PublishCompoundFormula, { formulaId: FORMULA_ID }, { idempotencyKey: "pub" })
    );

    expect(out).toMatchObject({
      formulaId: FORMULA_ID,
      code: "MAGIC-MOUTHWASH",
      version: 2,
      supersededFormulaId: PREDECESSOR_ID,
    });

    // Predecessor retirement is status-guarded (no reason code — the
    // supersede path is reasonless by design).
    const retire = findOnly(fake.calls, "compoundFormula", "updateMany");
    expect(retire.args).toMatchObject({
      where: { id: PREDECESSOR_ID, status: "ACTIVE" },
      data: { status: "RETIRED" },
    });
    expect(
      (retire.args as { data: Record<string, unknown> }).data["retiredReason"]
    ).toBeUndefined();

    const activate = findOnly(fake.calls, "compoundFormula", "update");
    expect(activate.args).toMatchObject({
      where: { id: FORMULA_ID },
      data: { status: "ACTIVE" },
    });

    const events = outboxPayloads(fake.calls);
    expect(events[0]).toMatchObject({ eventType: "compounding.formula.published.v1" });
    expect(events[0]?.["payload"]).toMatchObject({
      formulaId: FORMULA_ID,
      version: 2,
      publishedByUserId: USER_ID,
      supersededFormulaId: PREDECESSOR_ID,
    });
  });

  it("translates the one-ACTIVE-per-product P2002 into a typed conflict", async () => {
    // A DIFFERENT code's ACTIVE formula already claims this draft's
    // compound product: the partial unique fires on activation and the
    // publisher gets a decision, not a race.
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique violation", {
      code: "P2002",
      clientVersion: "test",
    });
    const fake = buildFakePrisma({
      formulaRow: { id: FORMULA_ID, code: "MAGIC-MOUTHWASH", version: 1, status: "DRAFT" },
      activePredecessor: null,
      formulaUpdateError: p2002,
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PublishCompoundFormula,
          { formulaId: FORMULA_ID },
          { idempotencyKey: "pub-claimed" }
        )
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_PRODUCT_ALREADY_CLAIMED" });
  });

  it("publishes a first version with no predecessor (supersededFormulaId null)", async () => {
    const fake = buildFakePrisma({
      formulaRow: { id: FORMULA_ID, code: "MAGIC-MOUTHWASH", version: 1, status: "DRAFT" },
      activePredecessor: null,
    });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(PublishCompoundFormula, { formulaId: FORMULA_ID }, { idempotencyKey: "pub1" })
    );

    expect(out.supersededFormulaId).toBeNull();
    expect(callsOf(fake.calls, "compoundFormula", "updateMany")).toHaveLength(0);
  });

  it("rejects publishing a non-DRAFT version", async () => {
    const fake = buildFakePrisma({
      formulaRow: { id: FORMULA_ID, code: "MAGIC-MOUTHWASH", version: 2, status: "RETIRED" },
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PublishCompoundFormula,
          { formulaId: FORMULA_ID },
          { idempotencyKey: "pub-bad" }
        )
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_INVALID_STATE" });
  });

  it("404s on an unknown formula", async () => {
    const fake = buildFakePrisma({ formulaRow: null });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          PublishCompoundFormula,
          { formulaId: FORMULA_ID },
          { idempotencyKey: "pub-404" }
        )
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------
// RetireCompoundFormula
// ---------------------------------------------------------------------

describe("RetireCompoundFormula", () => {
  it("retires an ACTIVE version with the reason code and emits the event", async () => {
    const fake = buildFakePrisma({
      formulaRow: { id: FORMULA_ID, code: "MAGIC-MOUTHWASH", version: 2, status: "ACTIVE" },
    });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RetireCompoundFormula,
        { formulaId: FORMULA_ID, reasonCode: "SAFETY" as const },
        { idempotencyKey: "retire" }
      )
    );

    expect(out).toMatchObject({ formulaId: FORMULA_ID, status: "RETIRED" });

    const update = findOnly(fake.calls, "compoundFormula", "update");
    expect(update.args).toMatchObject({
      where: { id: FORMULA_ID },
      data: { status: "RETIRED", retiredReason: "SAFETY" },
    });

    const events = outboxPayloads(fake.calls);
    expect(events[0]).toMatchObject({ eventType: "compounding.formula.retired.v1" });
    expect(events[0]?.["payload"]).toMatchObject({
      formulaId: FORMULA_ID,
      reasonCode: "SAFETY",
      retiredByUserId: USER_ID,
    });
  });

  it("rejects retiring a non-ACTIVE version", async () => {
    const fake = buildFakePrisma({
      formulaRow: { id: FORMULA_ID, code: "MAGIC-MOUTHWASH", version: 1, status: "DRAFT" },
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RetireCompoundFormula,
          { formulaId: FORMULA_ID, reasonCode: "ERROR" as const },
          { idempotencyKey: "retire-bad" }
        )
      )
    ).rejects.toMatchObject({ code: "COMPOUND_FORMULA_INVALID_STATE" });
  });

  it("rejects an out-of-enum reason code at the schema boundary", async () => {
    const fake = buildFakePrisma({
      formulaRow: { id: FORMULA_ID, code: "MAGIC-MOUTHWASH", version: 2, status: "ACTIVE" },
    });
    wireBusAndRbac(fake.client);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(
          RetireCompoundFormula,
          {
            formulaId: FORMULA_ID,
            reasonCode: "BECAUSE" as unknown as "SAFETY",
          },
          { idempotencyKey: "retire-enum" }
        )
      )
    ).rejects.toThrow();

    expect(callsOf(fake.calls, "compoundFormula", "update")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------

describe("compound formula commands — RBAC", () => {
  it("denies create without compounding.formula.manage and leaves no command_log footprint", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await expect(
      withTenancyContext(ctx(), () =>
        executeCommand(CreateCompoundFormula, validCreateInput(), { idempotencyKey: "rbac" })
      )
    ).rejects.toMatchObject({ httpStatus: 403 });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "compoundFormula", "create")).toHaveLength(0);
  });
});
