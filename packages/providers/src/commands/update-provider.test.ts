// UpdateProvider contract tests.
//
// The plaintext counterpart to UpdatePatient. Tests pin:
//
//   1. Selective writes — only columns the input names get a value;
//      unaddressed columns are absent from the SQL data payload.
//   2. Tri-state semantics — `undefined` skips, `null` clears
//      optional columns (writes SQL NULL), string sets. Identity
//      keys reject `null` at the Zod boundary AND at the handler's
//      defense-in-depth check.
//   3. Locked-out guards — INACTIVE rejects with PROVIDER_INACTIVE;
//      missing row surfaces 404; CAS race-lost translates to
//      PROVIDER_UPDATE_RACE_LOST with no audit/outbox.
//   4. NPI immutability — submitting `npi` is rejected at Zod
//      (`.strict()`) as COMMAND_INPUT_INVALID; `status` similarly
//      not in schema.
//   5. PHI rule — `command_log.requestPayload` redacts `deaNumber`;
//      audit metadata keeps NPI as anchor + structural diff +
//      post-update `hasDea`; outbox payload is ids + diff +
//      timestamp + NPI only.
//   6. No-op rejection — empty change set raises
//      PROVIDER_UPDATE_NO_CHANGES before any read.
//   7. RBAC — `providers.update` required; absence short-circuits
//      before any command_log row.
//
// DB is mocked end-to-end; the bus, RBAC loader, and tenancy GUC
// machinery run for real.

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

import { UpdateProvider } from "./update-provider.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PROVIDER_ID = "44444444-4444-4444-8444-444444444444";
const NPI = "1417935009";

const updateGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PROVIDERS_UPDATE]),
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
    status: ProviderStatus.ACTIVE,
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
  grants: ReadonlyArray<ResolvedGrant> = updateGrants
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
// Happy paths
// ---------------------------------------------------------------------

describe("UpdateProvider — happy path (single field)", () => {
  let fake: ReturnType<typeof buildFakePrisma>;

  beforeEach(() => {
    fake = buildFakePrisma({
      providerRow: buildProviderRow({ deaNumber: "BR1234567" }),
    });
    wireBusAndRbac(fake.client);
  });

  it("writes only the named column and returns the diff", async () => {
    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateProvider,
        { providerId: PROVIDER_ID, credential: "DO" },
        { idempotencyKey: "credential-only" }
      )
    );

    expect(out).toEqual({
      providerId: PROVIDER_ID,
      updatedAt: "2026-06-01T12:00:00.000Z",
      updatedFields: ["credential"],
      clearedFields: [],
    });

    const update = findOnly(fake.calls, "provider", "updateMany");
    const args = update.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };

    // CAS predicate: id + tenant + ACTIVE only.
    expect(args.where).toEqual({
      id: PROVIDER_ID,
      organizationId: ORG_ID,
      status: ProviderStatus.ACTIVE,
    });

    // Only the named column lands in data.
    expect(args.data).toEqual({ credential: "DO" });
  });
});

describe("UpdateProvider — happy path (mixed update + clear)", () => {
  it("writes set values + SQL NULL for cleared optionals, omits absent keys", async () => {
    const fake = buildFakePrisma({
      providerRow: buildProviderRow({ deaNumber: "BR1234567" }),
    });
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateProvider,
        {
          providerId: PROVIDER_ID,
          // Update.
          firstName: "Hannah",
          credential: "MD",
          phone: "(415) 555-0199",
          // Clear (null on optionals).
          email: null,
          addressLine2: null,
          // Absent fields are not in the payload at all.
        },
        { idempotencyKey: "mixed" }
      )
    );

    expect(out.updatedFields).toEqual(["credential", "firstName", "phone"]);
    expect(out.clearedFields).toEqual(["addressLine2", "email"]);

    const data = (
      findOnly(fake.calls, "provider", "updateMany").args as {
        data: Record<string, unknown>;
      }
    ).data;

    expect(data).toEqual({
      firstName: "Hannah",
      credential: "MD",
      phone: "(415) 555-0199",
      email: null,
      addressLine2: null,
    });

    // Untouched columns are absent (not `undefined`, not `null`).
    for (const k of ["lastName", "deaNumber", "addressLine1", "city", "state", "postalCode"]) {
      expect(k in data).toBe(false);
    }
  });
});

describe("UpdateProvider — happy path (clearing DEA flips hasDea)", () => {
  it("hasDea reflects post-update state when DEA is cleared", async () => {
    const fake = buildFakePrisma({
      providerRow: buildProviderRow({ deaNumber: "BR1234567" }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateProvider,
        { providerId: PROVIDER_ID, deaNumber: null },
        { idempotencyKey: "clear-dea" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const metadata = (audit.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(metadata["hasDea"]).toBe(false);
  });

  it("hasDea reflects post-update state when DEA is set", async () => {
    const fake = buildFakePrisma({
      providerRow: buildProviderRow({ deaNumber: null }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateProvider,
        { providerId: PROVIDER_ID, deaNumber: "BR1234567" },
        { idempotencyKey: "set-dea" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const metadata = (audit.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(metadata["hasDea"]).toBe(true);
  });

  it("hasDea preserves pre-read state when DEA is untouched", async () => {
    const fake = buildFakePrisma({
      providerRow: buildProviderRow({ deaNumber: "BR1234567" }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateProvider,
        { providerId: PROVIDER_ID, credential: "DO" },
        { idempotencyKey: "untouched-dea" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const metadata = (audit.args as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(metadata["hasDea"]).toBe(true);
  });
});

// ---------------------------------------------------------------------
// command_log redaction
// ---------------------------------------------------------------------

describe("UpdateProvider — command_log redaction", () => {
  it("redacts ONLY deaNumber from requestPayload; other fields survive", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateProvider,
        {
          providerId: PROVIDER_ID,
          firstName: "Hannah",
          credential: "MD",
          deaNumber: "BR1234567",
          email: "office@reyes-clinic.test",
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

    expect(payload["deaNumber"]).toBe("[Redacted]");

    expect(payload["providerId"]).toBe(PROVIDER_ID);
    expect(payload["firstName"]).toBe("Hannah");
    expect(payload["credential"]).toBe("MD");
    expect(payload["email"]).toBe("office@reyes-clinic.test");

    const cmdLogJson = JSON.stringify(cmdLogCreate.args);
    expect(cmdLogJson).not.toContain("BR1234567");
  });
});

// ---------------------------------------------------------------------
// Audit + outbox shape
// ---------------------------------------------------------------------

describe("UpdateProvider — audit + outbox shape", () => {
  it("audit metadata carries NPI + sorted diff lists + hasDea; no DEA plaintext", async () => {
    const fake = buildFakePrisma({
      providerRow: buildProviderRow({ deaNumber: null }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateProvider,
        {
          providerId: PROVIDER_ID,
          firstName: "Hannah",
          credential: "MD",
          deaNumber: "BR1234567",
          email: null,
        },
        { idempotencyKey: "audit" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const data = (audit.args as { data: Record<string, unknown> }).data;

    expect(data["action"]).toBe("provider.updated");
    expect(data["resourceType"]).toBe("Provider");
    expect(data["resourceId"]).toBe(PROVIDER_ID);

    const metadata = data["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      npi: NPI,
      updatedFields: ["credential", "deaNumber", "firstName"],
      clearedFields: ["email"],
      hasDea: true,
    });
    expect(metadata["commandLogId"]).toBeDefined();

    const auditJson = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(auditJson).not.toContain("BR1234567");
  });

  it("outbox payload is ids + npi + diff + timestamp only; no plaintext PII", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdateProvider,
        {
          providerId: PROVIDER_ID,
          firstName: "Hannah",
          lastName: "Reyes",
          deaNumber: "BR1234567",
        },
        { idempotencyKey: "outbox" }
      )
    );

    const outbox = findOnly(fake.calls, "eventOutbox", "createMany");
    const events = (outbox.args as { data: Array<Record<string, unknown>> }).data;
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event).toMatchObject({
      eventType: "provider.updated.v1",
      aggregateType: "Provider",
      aggregateId: PROVIDER_ID,
      organizationId: ORG_ID,
    });

    const payload = event["payload"] as Record<string, unknown>;
    expect(payload).toEqual({
      providerId: PROVIDER_ID,
      organizationId: ORG_ID,
      npi: NPI,
      updatedFields: ["deaNumber", "firstName", "lastName"],
      clearedFields: [],
      occurredAt: "2026-06-01T12:00:00.000Z",
    });

    const payloadJson = JSON.stringify(payload);
    expect(payloadJson).not.toContain("BR1234567");
    expect(payloadJson).not.toContain("Hannah");
    expect(payloadJson).not.toContain("Reyes");
  });
});

// ---------------------------------------------------------------------
// Locked-out states
// ---------------------------------------------------------------------

describe("UpdateProvider — locked-out states", () => {
  it("PROVIDER_NOT_FOUND when no row exists; no updateMany attempted", async () => {
    const fake = buildFakePrisma({ providerRow: null });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdateProvider,
          { providerId: PROVIDER_ID, credential: "MD" },
          { idempotencyKey: "not-found" }
        )
      ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    });

    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });

  it("PROVIDER_INACTIVE when row is deactivated; no updateMany attempted", async () => {
    const fake = buildFakePrisma({
      providerRow: buildProviderRow({ status: ProviderStatus.INACTIVE }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdateProvider,
          { providerId: PROVIDER_ID, credential: "MD" },
          { idempotencyKey: "inactive" }
        )
      ).rejects.toMatchObject({ code: "PROVIDER_INACTIVE" });
    });

    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// CAS race lost
// ---------------------------------------------------------------------

describe("UpdateProvider — CAS race lost", () => {
  it("count=0 from updateMany maps to PROVIDER_UPDATE_RACE_LOST; no audit/outbox", async () => {
    const fake = buildFakePrisma({ updateCount: 0 });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdateProvider,
          { providerId: PROVIDER_ID, credential: "MD" },
          { idempotencyKey: "race" }
        )
      ).rejects.toMatchObject({ code: "PROVIDER_UPDATE_RACE_LOST" });
    });

    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(1);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// No-op rejection
// ---------------------------------------------------------------------

describe("UpdateProvider — no-op rejection", () => {
  it("rejects when only providerId is provided; no read, no write", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(UpdateProvider, { providerId: PROVIDER_ID }, { idempotencyKey: "noop" })
      ).rejects.toMatchObject({ code: "PROVIDER_UPDATE_NO_CHANGES" });
    });

    expect(callsOf(fake.calls, "provider", "findUnique")).toHaveLength(0);
    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------

describe("UpdateProvider — RBAC", () => {
  it("rejects a caller without providers.update; no command_log row", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdateProvider,
          { providerId: PROVIDER_ID, credential: "MD" },
          { idempotencyKey: "no-perm" }
        )
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "provider", "findUnique")).toHaveLength(0);
    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

describe("UpdateProvider — input validation", () => {
  let fake: ReturnType<typeof buildFakePrisma>;

  beforeEach(() => {
    fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
  });

  it.each([
    ["npi rejected (immutable; strict schema)", { providerId: PROVIDER_ID, npi: "1234567893" }],
    [
      "status rejected (separate command DeactivateProvider)",
      { providerId: PROVIDER_ID, status: "INACTIVE" },
    ],
    ["extra fields rejected", { providerId: PROVIDER_ID, website: "https://x.test" }],
    ["DEA wrong shape", { providerId: PROVIDER_ID, deaNumber: "br1234567" }],
    ["DEA wrong length", { providerId: PROVIDER_ID, deaNumber: "BR123456" }],
    ["email malformed", { providerId: PROVIDER_ID, email: "not-an-email" }],
    ["state must be 2 uppercase letters", { providerId: PROVIDER_ID, state: "Cal" }],
    ["postalCode shape", { providerId: PROVIDER_ID, postalCode: "abcde" }],
    ["firstName cannot be null (identity)", { providerId: PROVIDER_ID, firstName: null }],
    ["lastName cannot be null (identity)", { providerId: PROVIDER_ID, lastName: null }],
    ["providerId must be a UUID", { providerId: "not-a-uuid", credential: "MD" }],
  ] as const)("rejects: %s", async (_label, input) => {
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(UpdateProvider, input as never, {
          idempotencyKey: `invalid-${_label.slice(0, 12)}-${Math.random()}`,
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    // Validation runs before any DB read or write.
    expect(callsOf(fake.calls, "provider", "findUnique")).toHaveLength(0);
    expect(callsOf(fake.calls, "provider", "updateMany")).toHaveLength(0);
  });
});
