// ReactivateProvider contract tests.
//
// Mirrors the DeactivateProvider test file in structure (mocked
// Prisma, real bus + RBAC + tenancy machinery) but pins the
// reactivation command's specific contract:
//
//   1. Happy path — INACTIVE row flips to ACTIVE via a CAS
//      predicate; output carries the echoed reason; only `status`
//      lands in the SQL data payload (no incidental column writes).
//   2. Reason enum coverage — every closed-enum reactivation code
//      is accepted at Zod and carries through to audit metadata +
//      outbox payload verbatim. The vocabulary is intentionally
//      DISTINCT from PROVIDER_DEACTIVATION_REASONS — this test
//      pins that distinction (no `RETIRED`, no `DECEASED`, no
//      `DUPLICATE_RECORD`, etc. accepted by the Zod boundary).
//   3. PHI rule — `reasonText` is redacted from
//      `command_log.requestPayload`; never appears in audit
//      metadata or outbox payload; presence flagged as
//      `hasReasonText` only.
//   4. `hadDea` snapshot — pre-reactivation DEA nullity is captured
//      in audit metadata + outbox payload (resume-CS-fills workers
//      consume this).
//   5. Locked-out states — missing row surfaces PROVIDER_NOT_FOUND;
//      already-ACTIVE surfaces PROVIDER_ALREADY_ACTIVE; neither
//      writes audit / outbox / updateMany.
//   6. CAS race lost — count=0 from updateMany maps to
//      PROVIDER_REACTIVATE_RACE_LOST with no audit/outbox.
//   7. OTHER requires reasonText — Zod refinement rejects
//      `reason: OTHER` without `reasonText` as
//      COMMAND_INPUT_INVALID.
//   8. RBAC — `providers.reactivate` required; absence
//      short-circuits before any command_log row.
//      `providers.deactivate` alone is NOT sufficient (the two
//      grants are deliberately separable).
//   9. Input validation — strict schema rejects unknown keys and
//      invalid reason codes (including DEACTIVATION codes — they
//      are typed-distinct from this command's vocabulary).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import { ProviderStatus, RoleScope } from "@pharmax/database";
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
  PROVIDER_REACTIVATION_REASONS,
  ReactivateProvider,
  type ProviderReactivationReason,
} from "./reactivate-provider.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PROVIDER_ID = "44444444-4444-4444-8444-444444444444";
const NPI = "1417935009";

const reactivateGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PROVIDERS_REACTIVATE]),
  },
];

const readOnlyGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PROVIDERS_READ]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

// ---------------------------------------------------------------------
// Fake Prisma
// ---------------------------------------------------------------------

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface ProviderReadRow {
  id: string;
  organizationId: string;
  npi: string;
  status: ProviderStatus;
  deaNumber: string | null;
}

interface FakePrismaOptions {
  /** Row returned by `provider.findUnique`. `null` exercises not-found. */
  providerRow?: ProviderReadRow | null;
  /** Count returned by `provider.updateMany`. 0 exercises race-lost. */
  updateCount?: number;
}

function buildProviderRow(overrides: Partial<ProviderReadRow> = {}): ProviderReadRow {
  return {
    id: PROVIDER_ID,
    organizationId: ORG_ID,
    npi: NPI,
    // Default fixture is INACTIVE — the row state ReactivateProvider
    // is meant to operate on. (DeactivateProvider's default is
    // ACTIVE; this asymmetry is deliberate.)
    status: ProviderStatus.INACTIVE,
    deaNumber: null,
    ...overrides,
  };
}

function buildFakePrisma(opts: FakePrismaOptions = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const updateCount = opts.updateCount ?? 1;
  const row = opts.providerRow === undefined ? buildProviderRow() : opts.providerRow;

  const tx = {
    provider: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "provider", op: "findUnique", args });
        return row;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "provider", op: "updateMany", args });
        return { count: updateCount };
      }),
    },
    commandLog: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "commandLog", op: "create", args });
        return { id: "cmd-log-1" };
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

function wireBusAndRbac(
  client: unknown,
  grants: ReadonlyArray<ResolvedGrant> = reactivateGrants
): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(new Date("2026-06-01T12:00:00.000Z")),
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
// Happy path
// ---------------------------------------------------------------------

describe("ReactivateProvider — happy path", () => {
  it("flips INACTIVE → ACTIVE via CAS predicate; output echoes reason", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        ReactivateProvider,
        { providerId: PROVIDER_ID, reason: "LICENSE_RESTORED" },
        { idempotencyKey: "license-restored" }
      )
    );

    expect(out).toEqual({
      providerId: PROVIDER_ID,
      reactivatedAt: "2026-06-01T12:00:00.000Z",
      reason: "LICENSE_RESTORED",
    });

    const update = findOnly(fake.calls, "provider", "updateMany");
    const args = update.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };

    // CAS predicate: id + tenant + INACTIVE only.
    expect(args.where).toEqual({
      id: PROVIDER_ID,
      organizationId: ORG_ID,
      status: ProviderStatus.INACTIVE,
    });

    // Only the status column is written — no incidental edits.
    expect(args.data).toEqual({ status: ProviderStatus.ACTIVE });
  });

  it("accepts optional reasonText alongside non-OTHER reason codes", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        ReactivateProvider,
        {
          providerId: PROVIDER_ID,
          reason: "DEA_RESTORED",
          reasonText: "DEA reinstated 2026-05-30 after settlement.",
        },
        { idempotencyKey: "dea-restored-with-text" }
      )
    );

    expect(out.reason).toBe("DEA_RESTORED");
  });
});

// ---------------------------------------------------------------------
// Reason enum coverage
// ---------------------------------------------------------------------

describe("ReactivateProvider — reason enum coverage", () => {
  // OTHER is exercised separately because it carries the reasonText
  // refinement. Every other code is accepted bare and rides into
  // audit + outbox verbatim.
  const NON_OTHER_REASONS = PROVIDER_REACTIVATION_REASONS.filter(
    (r) => r !== "OTHER"
  ) as ReadonlyArray<ProviderReactivationReason>;

  it.each(NON_OTHER_REASONS)("accepts reason: %s and surfaces it in audit + outbox", async (r) => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        ReactivateProvider,
        { providerId: PROVIDER_ID, reason: r },
        { idempotencyKey: `reason-${r}` }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const auditMeta = (audit.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(auditMeta["reason"]).toBe(r);

    const outbox = findOnly(fake.calls, "eventOutbox", "createMany");
    const events = (outbox.args as { data: Array<Record<string, unknown>> }).data;
    const payload = events[0]?.["payload"] as Record<string, unknown>;
    expect(payload["reason"]).toBe(r);
  });

  it("accepts reason: OTHER when reasonText is provided", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        ReactivateProvider,
        {
          providerId: PROVIDER_ID,
          reason: "OTHER",
          reasonText: "Provider returned to roster at clinic request.",
        },
        { idempotencyKey: "other-with-text" }
      )
    );

    expect(out.reason).toBe("OTHER");
  });

  it("rejects DEACTIVATION reason codes (vocabularies are typed-distinct)", async () => {
    // The two reason vocabularies share the OTHER escape hatch but
    // nothing else. Pinning this distinction here so a future
    // refactor can't silently re-merge them and let `DECEASED`,
    // `RETIRED`, `DUPLICATE_RECORD`, etc. flow through this command.
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const DEACTIVATION_ONLY = [
      "RETIRED",
      "RELOCATED",
      "RELATIONSHIP_ENDED",
      "LICENSE_EXPIRED",
      "DEA_SURRENDERED_OR_REVOKED",
      "SANCTIONED",
      "DECEASED",
      "DUPLICATE_RECORD",
    ] as const;

    await withTenancyContext(ctx(), async () => {
      for (const r of DEACTIVATION_ONLY) {
        await expect(
          executeCommand(
            ReactivateProvider,
            { providerId: PROVIDER_ID, reason: r as never },
            { idempotencyKey: `deact-code-${r}` }
          )
        ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
      }
    });

    expect(callsOf(fake.calls, "provider", "findUnique")).toHaveLength(0);
    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// command_log redaction
// ---------------------------------------------------------------------

describe("ReactivateProvider — command_log redaction", () => {
  it("redacts ONLY reasonText from requestPayload; reason code survives", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        ReactivateProvider,
        {
          providerId: PROVIDER_ID,
          reason: "SANCTION_LIFTED",
          reasonText: "State board reinstated license 2026-08-01 with conditions.",
        },
        { idempotencyKey: "redact" }
      )
    );

    const cmdLogCreate = findOnly(fake.calls, "commandLog", "create");
    const payload = (
      cmdLogCreate.args as {
        data: { requestPayload: Record<string, unknown> };
      }
    ).data.requestPayload;

    expect(payload["reasonText"]).toBe("[Redacted]");
    expect(payload["reason"]).toBe("SANCTION_LIFTED");
    expect(payload["providerId"]).toBe(PROVIDER_ID);

    const cmdLogJson = JSON.stringify(cmdLogCreate.args);
    expect(cmdLogJson).not.toContain("State board reinstated");
    expect(cmdLogJson).not.toContain("with conditions");
  });

  it("omits reasonText entirely when not provided", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        ReactivateProvider,
        { providerId: PROVIDER_ID, reason: "RETURNED_FROM_RETIREMENT" },
        { idempotencyKey: "no-text" }
      )
    );

    const cmdLogCreate = findOnly(fake.calls, "commandLog", "create");
    const payload = (
      cmdLogCreate.args as {
        data: { requestPayload: Record<string, unknown> };
      }
    ).data.requestPayload;

    expect("reasonText" in payload).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Audit + outbox shape (PHI rule)
// ---------------------------------------------------------------------

describe("ReactivateProvider — audit + outbox shape", () => {
  it("audit metadata carries npi + reason + hasReasonText + hadDea; no reasonText", async () => {
    const fake = buildFakePrisma({
      providerRow: buildProviderRow({ deaNumber: "BR1234567" }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        ReactivateProvider,
        {
          providerId: PROVIDER_ID,
          reason: "DEA_RESTORED",
          reasonText: "DEA registration restored 2026-05-30.",
        },
        { idempotencyKey: "audit-shape" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const data = (audit.args as { data: Record<string, unknown> }).data;

    expect(data["action"]).toBe("provider.reactivated");
    expect(data["resourceType"]).toBe("Provider");
    expect(data["resourceId"]).toBe(PROVIDER_ID);

    const metadata = data["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      npi: NPI,
      reason: "DEA_RESTORED",
      hasReasonText: true,
      hadDea: true,
    });
    expect(metadata["commandLogId"]).toBeDefined();
    expect("reasonText" in metadata).toBe(false);

    const auditJson = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(auditJson).not.toContain("DEA registration restored");
    expect(auditJson).not.toContain("BR1234567");
  });

  it("outbox payload is ids + npi + reason + hasReasonText + hadDea + ts; no reasonText", async () => {
    const fake = buildFakePrisma({
      providerRow: buildProviderRow({ deaNumber: "BR1234567" }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        ReactivateProvider,
        {
          providerId: PROVIDER_ID,
          reason: "SANCTION_LIFTED",
          reasonText: "Sensitive details about hearing outcome.",
        },
        { idempotencyKey: "outbox-shape" }
      )
    );

    const outbox = findOnly(fake.calls, "eventOutbox", "createMany");
    const events = (outbox.args as { data: Array<Record<string, unknown>> }).data;
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event).toMatchObject({
      eventType: "provider.reactivated.v1",
      aggregateType: "Provider",
      aggregateId: PROVIDER_ID,
      organizationId: ORG_ID,
    });

    const payload = event["payload"] as Record<string, unknown>;
    expect(payload).toEqual({
      providerId: PROVIDER_ID,
      organizationId: ORG_ID,
      npi: NPI,
      reason: "SANCTION_LIFTED",
      hasReasonText: true,
      hadDea: true,
      occurredAt: "2026-06-01T12:00:00.000Z",
    });

    const payloadJson = JSON.stringify(payload);
    expect(payloadJson).not.toContain("Sensitive details");
    expect(payloadJson).not.toContain("BR1234567");
  });

  it("hadDea reflects nullity of pre-reactivation row (no DEA on file)", async () => {
    const fake = buildFakePrisma({
      providerRow: buildProviderRow({ deaNumber: null }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        ReactivateProvider,
        { providerId: PROVIDER_ID, reason: "RELOCATED_BACK_INTO_AREA" },
        { idempotencyKey: "no-dea" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const metadata = (audit.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(metadata["hadDea"]).toBe(false);
  });

  it("hasReasonText is false when reasonText is omitted", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        ReactivateProvider,
        { providerId: PROVIDER_ID, reason: "RELATIONSHIP_RESUMED" },
        { idempotencyKey: "no-text-flag" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const metadata = (audit.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(metadata["hasReasonText"]).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Locked-out states
// ---------------------------------------------------------------------

describe("ReactivateProvider — locked-out states", () => {
  it("PROVIDER_NOT_FOUND when no row exists; no updateMany attempted", async () => {
    const fake = buildFakePrisma({ providerRow: null });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          ReactivateProvider,
          { providerId: PROVIDER_ID, reason: "LICENSE_RESTORED" },
          { idempotencyKey: "not-found" }
        )
      ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    });

    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("PROVIDER_ALREADY_ACTIVE when row is already active; no updateMany", async () => {
    const fake = buildFakePrisma({
      providerRow: buildProviderRow({ status: ProviderStatus.ACTIVE }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          ReactivateProvider,
          { providerId: PROVIDER_ID, reason: "LICENSE_RESTORED" },
          { idempotencyKey: "already-active" }
        )
      ).rejects.toMatchObject({ code: "PROVIDER_ALREADY_ACTIVE" });
    });

    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// CAS race lost
// ---------------------------------------------------------------------

describe("ReactivateProvider — CAS race lost", () => {
  it("count=0 from updateMany maps to PROVIDER_REACTIVATE_RACE_LOST; no audit/outbox", async () => {
    const fake = buildFakePrisma({ updateCount: 0 });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          ReactivateProvider,
          { providerId: PROVIDER_ID, reason: "LICENSE_RESTORED" },
          { idempotencyKey: "race" }
        )
      ).rejects.toMatchObject({ code: "PROVIDER_REACTIVATE_RACE_LOST" });
    });

    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// OTHER requires reasonText
// ---------------------------------------------------------------------

describe("ReactivateProvider — OTHER refinement", () => {
  it("rejects OTHER without reasonText (Zod refine)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          ReactivateProvider,
          { providerId: PROVIDER_ID, reason: "OTHER" },
          { idempotencyKey: "other-no-text" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });

    expect(callsOf(fake.calls, "provider", "findUnique")).toHaveLength(0);
    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
  });

  it("rejects OTHER with empty-string reasonText", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          ReactivateProvider,
          { providerId: PROVIDER_ID, reason: "OTHER", reasonText: "" },
          { idempotencyKey: "other-empty-text" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });

    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------

describe("ReactivateProvider — RBAC", () => {
  it("rejects a caller without providers.reactivate; no command_log row", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          ReactivateProvider,
          { providerId: PROVIDER_ID, reason: "LICENSE_RESTORED" },
          { idempotencyKey: "no-perm" }
        )
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "provider", "findUnique")).toHaveLength(0);
    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
  });

  it("providers.deactivate alone is NOT sufficient (separate grant)", async () => {
    // The two grants are deliberately separable: an organization
    // may want to allow a tech to take a provider OUT of service
    // while requiring a higher-trust role to bring them BACK in.
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, [
      {
        roleScope: RoleScope.ORGANIZATION,
        grantScope: { siteId: null, clinicId: null, teamId: null },
        permissions: new Set([PERMISSIONS.PROVIDERS_DEACTIVATE]),
      },
    ]);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          ReactivateProvider,
          { providerId: PROVIDER_ID, reason: "LICENSE_RESTORED" },
          { idempotencyKey: "deact-not-enough" }
        )
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
  });

  it("providers.update alone is NOT sufficient (separate grant)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, [
      {
        roleScope: RoleScope.ORGANIZATION,
        grantScope: { siteId: null, clinicId: null, teamId: null },
        permissions: new Set([PERMISSIONS.PROVIDERS_UPDATE]),
      },
    ]);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          ReactivateProvider,
          { providerId: PROVIDER_ID, reason: "LICENSE_RESTORED" },
          { idempotencyKey: "update-not-enough" }
        )
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

describe("ReactivateProvider — input validation", () => {
  let fake: ReturnType<typeof buildFakePrisma>;

  beforeEach(() => {
    fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
  });

  it.each([
    ["providerId must be a UUID", { providerId: "not-a-uuid", reason: "LICENSE_RESTORED" }],
    [
      "reason must be a known enum value",
      { providerId: PROVIDER_ID, reason: "MADE_UP_REASON" as never },
    ],
    [
      "extra fields rejected (strict schema)",
      { providerId: PROVIDER_ID, reason: "LICENSE_RESTORED", note: "extra" },
    ],
    [
      "status key rejected (caller cannot pick the target status)",
      { providerId: PROVIDER_ID, reason: "LICENSE_RESTORED", status: "ACTIVE" },
    ],
    [
      "reasonText over 2000 chars",
      { providerId: PROVIDER_ID, reason: "OTHER", reasonText: "x".repeat(2001) },
    ],
  ] as const)("rejects: %s", async (_label, input) => {
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(ReactivateProvider, input as never, {
          idempotencyKey: `invalid-${_label.slice(0, 12)}-${Math.random()}`,
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    expect(callsOf(fake.calls, "provider", "findUnique")).toHaveLength(0);
    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
  });
});
