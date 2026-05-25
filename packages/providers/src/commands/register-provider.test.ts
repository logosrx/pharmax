// RegisterProvider contract tests.
//
// The Provider write path is plaintext (NPI registry data is public),
// so the test surface is simpler than RegisterPatient. We still
// assert the same SOC 2-shaped invariants:
//
//   1. command_log.requestPayload redacts `deaNumber` (and NOTHING
//      else — NPI is intentionally preserved as the action's anchor).
//   2. audit_log metadata + outbox payload never contain the DEA
//      plaintext string anywhere.
//   3. NPI duplicate within the same org raises a TYPED conflict,
//      not a raw Prisma P2002 leak.
//   4. RBAC denial leaves ZERO command_log footprint.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { RegisterProvider } from "./register-provider.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const writerGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PROVIDERS_CREATE, PERMISSIONS.PROVIDERS_READ]),
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
// Fake Prisma — records every call. Returns deterministic ids.
// ---------------------------------------------------------------------

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakePrismaOptions {
  /** When set, `provider.create` throws this error (npi-duplicate path). */
  providerCreateError?: Error;
}

function buildFakePrisma(opts: FakePrismaOptions = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  const tx = {
    provider: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "provider", op: "create", args });
        if (opts.providerCreateError !== undefined) throw opts.providerCreateError;
        return (args as { data: { id: string } }).data;
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
  grants: ReadonlyArray<ResolvedGrant> = writerGrants
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

describe("RegisterProvider — happy path (required only)", () => {
  let fake: ReturnType<typeof buildFakePrisma>;

  beforeEach(() => {
    fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
  });

  it("creates the provider with required fields and leaves optional columns omitted", async () => {
    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterProvider,
        { npi: "1234567893", firstName: "Aisha", lastName: "Patel" },
        { idempotencyKey: "req-only" }
      )
    );

    expect(out.providerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    const create = findOnly(fake.calls, "provider", "create");
    const data = (create.args as { data: Record<string, unknown> }).data;

    expect(data["id"]).toBe(out.providerId);
    expect(data["organizationId"]).toBe(ORG_ID);
    expect(data["npi"]).toBe("1234567893");
    expect(data["firstName"]).toBe("Aisha");
    expect(data["lastName"]).toBe("Patel");
    expect(data["status"]).toBe("ACTIVE");

    for (const k of [
      "credential",
      "deaNumber",
      "phone",
      "email",
      "addressLine1",
      "addressLine2",
      "city",
      "state",
      "postalCode",
    ]) {
      expect(data[k]).toBeUndefined();
    }
  });
});

describe("RegisterProvider — happy path (all fields)", () => {
  it("passes every supplied field through to the provider row", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterProvider,
        {
          npi: "1417935009",
          firstName: "Hannah",
          lastName: "Reyes",
          credential: "MD",
          deaNumber: "BR1234567",
          phone: "(415) 555-0199",
          email: "office@reyes-clinic.test",
          addressLine1: "500 Howard St",
          addressLine2: "Suite 200",
          city: "San Francisco",
          state: "CA",
          postalCode: "94105-1234",
        },
        { idempotencyKey: "all-fields" }
      )
    );

    const data = (
      findOnly(fake.calls, "provider", "create").args as {
        data: Record<string, unknown>;
      }
    ).data;

    expect(data).toMatchObject({
      npi: "1417935009",
      firstName: "Hannah",
      lastName: "Reyes",
      credential: "MD",
      deaNumber: "BR1234567",
      phone: "(415) 555-0199",
      email: "office@reyes-clinic.test",
      addressLine1: "500 Howard St",
      addressLine2: "Suite 200",
      city: "San Francisco",
      state: "CA",
      postalCode: "94105-1234",
      status: "ACTIVE",
    });
  });
});

// ---------------------------------------------------------------------
// command_log redaction — DEA only, NPI preserved
// ---------------------------------------------------------------------

describe("RegisterProvider — command_log redaction", () => {
  it("redacts ONLY deaNumber from requestPayload; NPI and other fields survive", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterProvider,
        {
          npi: "1417935009",
          firstName: "Hannah",
          lastName: "Reyes",
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

    // Non-sensitive fields survive verbatim.
    expect(payload["npi"]).toBe("1417935009");
    expect(payload["firstName"]).toBe("Hannah");
    expect(payload["lastName"]).toBe("Reyes");
    expect(payload["credential"]).toBe("MD");
    expect(payload["email"]).toBe("office@reyes-clinic.test");

    // Belt-and-suspenders: DEA plaintext appears NOWHERE in the
    // serialized command_log row.
    const cmdLogJson = JSON.stringify(cmdLogCreate.args);
    expect(cmdLogJson).not.toContain("BR1234567");
  });
});

// ---------------------------------------------------------------------
// Audit + outbox shape
// ---------------------------------------------------------------------

describe("RegisterProvider — audit + outbox shape", () => {
  it("audit metadata carries NPI + presence booleans; no DEA plaintext", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterProvider,
        {
          npi: "1417935009",
          firstName: "Hannah",
          lastName: "Reyes",
          credential: "MD",
          deaNumber: "BR1234567",
          phone: "(415) 555-0199",
        },
        { idempotencyKey: "audit" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const data = (audit.args as { data: Record<string, unknown> }).data;

    expect(data["action"]).toBe("provider.registered");
    expect(data["resourceType"]).toBe("Provider");
    expect(data["resourceId"]).toBe(out.providerId);

    const metadata = data["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      npi: "1417935009",
      hasDea: true,
      hasCredential: true,
      hasContact: true,
      hasAddress: false,
    });

    // The DEA plaintext does NOT appear anywhere in the audit row.
    // The audit row carries a BigInt `seq` column from the chain
    // writer, so JSON.stringify needs a BigInt-aware replacer.
    const auditJson = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(auditJson).not.toContain("BR1234567");
  });

  it("outbox event carries only ids + npi + timestamp; no DEA", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterProvider,
        {
          npi: "1417935009",
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
      eventType: "provider.registered.v1",
      aggregateType: "Provider",
      aggregateId: out.providerId,
      organizationId: ORG_ID,
    });

    const payload = event["payload"] as Record<string, unknown>;
    expect(payload).toEqual({
      providerId: out.providerId,
      organizationId: ORG_ID,
      npi: "1417935009",
      occurredAt: "2026-06-01T12:00:00.000Z",
    });

    const payloadJson = JSON.stringify(payload);
    expect(payloadJson).not.toContain("BR1234567");
    expect(payloadJson).not.toContain("Hannah");
    expect(payloadJson).not.toContain("Reyes");
  });
});

// ---------------------------------------------------------------------
// Conflict (NPI already registered)
// ---------------------------------------------------------------------

describe("RegisterProvider — NPI duplicate", () => {
  it("maps Prisma P2002 to ConflictError(PROVIDER_NPI_TAKEN) and writes no audit/outbox", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`organizationId`,`npi`)",
      { code: "P2002", clientVersion: "5.22.0" }
    );
    const fake = buildFakePrisma({ providerCreateError: p2002 });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterProvider,
          { npi: "1417935009", firstName: "Hannah", lastName: "Reyes" },
          { idempotencyKey: "dup" }
        )
      ).rejects.toMatchObject({ code: "PROVIDER_NPI_TAKEN" });
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------

describe("RegisterProvider — RBAC", () => {
  it("rejects a caller without providers.create permission and leaves no command_log row", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterProvider,
          { npi: "1417935009", firstName: "Hannah", lastName: "Reyes" },
          { idempotencyKey: "no-perm" }
        )
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "provider", "create")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

describe("RegisterProvider — input validation", () => {
  let fake: ReturnType<typeof buildFakePrisma>;

  beforeEach(() => {
    fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
  });

  it.each([
    ["NPI must be exactly 10 digits", { npi: "123", firstName: "A", lastName: "B" }],
    ["NPI non-digit", { npi: "12345abcde", firstName: "A", lastName: "B" }],
    [
      "DEA must be 2 letters + 7 digits (uppercase)",
      { npi: "1234567893", firstName: "A", lastName: "B", deaNumber: "br1234567" },
    ],
    [
      "DEA wrong length",
      { npi: "1234567893", firstName: "A", lastName: "B", deaNumber: "BR123456" },
    ],
    [
      "email malformed",
      { npi: "1234567893", firstName: "A", lastName: "B", email: "not-an-email" },
    ],
    [
      "state must be 2 uppercase letters",
      { npi: "1234567893", firstName: "A", lastName: "B", state: "Cal" },
    ],
    ["postalCode shape", { npi: "1234567893", firstName: "A", lastName: "B", postalCode: "abcde" }],
    [
      "extra fields rejected (strict schema)",
      { npi: "1234567893", firstName: "A", lastName: "B", website: "https://x" },
    ],
  ] as const)("rejects: %s", async (_label, input) => {
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(RegisterProvider, input as never, {
          idempotencyKey: `invalid-${_label.slice(0, 8)}-${Math.random()}`,
        })
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
    // Validation runs before any DB write.
    expect(callsOf(fake.calls, "provider", "create")).toHaveLength(0);
  });
});
