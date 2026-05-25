// RegisterPatient contract tests.
//
// The first command in the platform that touches PHI. The tests
// pin both the storage shape (every PHI field encrypted, every
// searchable PHI field BI'd, NULL columns left NULL) AND the
// security invariants (audit metadata is PHI-free, outbox events
// are PHI-free, command_log requestPayload has every PHI key
// redacted, decrypt round-trips, BIs are deterministic).
//
// We mock Prisma so the test stays DB-free, but use a REAL
// `LocalKmsAdapter` so encryption/blind-index code paths execute
// for real (no mocked crypto — that's the value we're verifying).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCrypto,
  decryptField,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
} from "@pharmax/crypto";
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

import { RegisterPatient } from "./register-patient.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CLINIC_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const tenantGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PATIENTS_CREATE, PERMISSIONS.PATIENTS_READ]),
  },
];

const readOnlyGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PATIENTS_READ]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

// ---------------------------------------------------------------------
// Fake Prisma — records every call. Returns deterministic ids so
// tests can assert on row contents.
// ---------------------------------------------------------------------

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface FakePrismaOptions {
  /** When false, `clinic.findUnique` returns null (clinic-not-found path). */
  clinicExists?: boolean;
  /** When set, `patient.create` throws this error (race condition path). */
  patientCreateError?: Error;
}

function buildFakePrisma(opts: FakePrismaOptions = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const clinicExists = opts.clinicExists !== false;

  const tx = {
    clinic: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "findUnique", args });
        if (!clinicExists) return null;
        const a = args as { where: { id: string } };
        return { id: a.where.id, organizationId: ORG_ID };
      }),
    },
    patient: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "patient", op: "create", args });
        if (opts.patientCreateError !== undefined) throw opts.patientCreateError;
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

// ---------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------

beforeEach(() => {
  // Real LocalKmsAdapter — encryption + blind index code paths
  // execute for real. The seed is per-suite so tests are isolated.
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "register-patient-test-seed" }) });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
});

function wireBusAndRbac(
  client: unknown,
  grants: ReadonlyArray<ResolvedGrant> = tenantGrants
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

// ---------------------------------------------------------------------
// Happy path — required fields only
// ---------------------------------------------------------------------

describe("RegisterPatient — happy path (required only)", () => {
  it("creates the patient with required *Enc/*Bi populated and optional columns omitted", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1990-04-15",
        },
        { idempotencyKey: "test-key-1" }
      )
    );

    expect(out.patientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    const create = findOnly(fake.calls, "patient", "create");
    const data = (create.args as { data: Record<string, unknown> }).data;

    expect(data["id"]).toBe(out.patientId);
    expect(data["organizationId"]).toBe(ORG_ID);
    expect(data["clinicId"]).toBe(CLINIC_ID);

    // Required *Enc envelopes present.
    expect(data["firstNameEnc"]).toMatchObject({ v: 1, alg: "AES-256-GCM" });
    expect(data["lastNameEnc"]).toMatchObject({ v: 1, alg: "AES-256-GCM" });
    expect(data["dateOfBirthEnc"]).toMatchObject({ v: 1, alg: "AES-256-GCM" });

    // Required *Bi are 43-char base64url HMAC outputs.
    for (const k of ["firstNameBi", "lastNameBi", "dobBi", "dobYearMonthBi"]) {
      const v = data[k];
      expect(typeof v).toBe("string");
      expect((v as string).length).toBe(43);
      expect(v as string).toMatch(/^[A-Za-z0-9_-]+$/);
    }

    // Optional *Enc / *Bi columns NOT passed (Prisma writes NULL).
    for (const k of [
      "middleNameEnc",
      "sexAtBirthEnc",
      "ssnLast4Enc",
      "phoneEnc",
      "emailEnc",
      "addressLine1Enc",
      "addressLine2Enc",
      "cityEnc",
      "stateEnc",
      "postalCodeEnc",
      "mrnEnc",
      "phoneLast10Bi",
      "emailBi",
      "postalCodeBi",
      "mrnBi",
    ]) {
      expect(data[k]).toBeUndefined();
    }

    expect(data["status"]).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------
// Happy path — all fields
// ---------------------------------------------------------------------

describe("RegisterPatient — happy path (all fields)", () => {
  it("encrypts every PHI field and blind-indexes every searchable PHI field", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1990-04-15",
          middleName: "Q",
          sexAtBirth: "FEMALE",
          ssnLast4: "1234",
          phone: "(415) 555-0100",
          email: "jane@example.test",
          addressLine1: "123 Main St",
          addressLine2: "Apt 4",
          city: "San Francisco",
          state: "CA",
          postalCode: "94110",
          mrn: "MRN-99001",
        },
        { idempotencyKey: "test-key-all" }
      )
    );

    const data = (
      findOnly(fake.calls, "patient", "create").args as {
        data: Record<string, unknown>;
      }
    ).data;

    // Every encrypted column is an envelope shape.
    for (const k of [
      "firstNameEnc",
      "lastNameEnc",
      "dateOfBirthEnc",
      "middleNameEnc",
      "sexAtBirthEnc",
      "ssnLast4Enc",
      "phoneEnc",
      "emailEnc",
      "addressLine1Enc",
      "addressLine2Enc",
      "cityEnc",
      "stateEnc",
      "postalCodeEnc",
      "mrnEnc",
    ]) {
      expect(data[k]).toMatchObject({ v: 1, alg: "AES-256-GCM" });
    }
    // Every blind index is a 43-char base64url string.
    for (const k of [
      "firstNameBi",
      "lastNameBi",
      "dobBi",
      "dobYearMonthBi",
      "phoneLast10Bi",
      "emailBi",
      "postalCodeBi",
      "mrnBi",
    ]) {
      expect(typeof data[k]).toBe("string");
      expect((data[k] as string).length).toBe(43);
    }
  });
});

// ---------------------------------------------------------------------
// PHI invariant — command_log.requestPayload redaction
// ---------------------------------------------------------------------

describe("RegisterPatient — command_log redaction", () => {
  it("replaces every PHI field in command_log.requestPayload with [Redacted]", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1990-04-15",
          middleName: "Q",
          sexAtBirth: "FEMALE",
          ssnLast4: "1234",
          phone: "(415) 555-0100",
          email: "jane@example.test",
          addressLine1: "123 Main St",
          addressLine2: "Apt 4",
          city: "San Francisco",
          state: "CA",
          postalCode: "94110",
          mrn: "MRN-99001",
        },
        { idempotencyKey: "test-key-redact" }
      )
    );

    const cmdLogCreate = findOnly(fake.calls, "commandLog", "create");
    const payload = (
      cmdLogCreate.args as {
        data: { requestPayload: Record<string, unknown> };
      }
    ).data.requestPayload;

    // clinicId is NOT PHI and must survive.
    expect(payload["clinicId"]).toBe(CLINIC_ID);

    // Every PHI key is censored. Spot-check the full list.
    for (const k of [
      "firstName",
      "lastName",
      "dateOfBirth",
      "middleName",
      "sexAtBirth",
      "ssnLast4",
      "phone",
      "email",
      "addressLine1",
      "addressLine2",
      "city",
      "state",
      "postalCode",
      "mrn",
    ]) {
      expect(payload[k]).toBe("[Redacted]");
    }
  });
});

// ---------------------------------------------------------------------
// PHI invariant — audit metadata is PHI-free
// ---------------------------------------------------------------------

describe("RegisterPatient — audit + outbox shape", () => {
  it("audit metadata contains booleans + clinicId only (no PHI)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1990-04-15",
          phone: "(415) 555-0100",
          mrn: "MRN-1",
        },
        { idempotencyKey: "test-key-audit" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const data = (audit.args as { data: Record<string, unknown> }).data;

    expect(data["action"]).toBe("patient.registered");
    expect(data["resourceType"]).toBe("Patient");
    expect(data["resourceId"]).toBe(out.patientId);

    const metadata = data["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      clinicId: CLINIC_ID,
      hasMrn: true,
      hasPhone: true,
      hasEmail: false,
      hasAddress: false,
      hasSsnLast4: false,
      hasMiddleName: false,
      hasSexAtBirth: false,
    });

    // No PHI substring leaks anywhere in the audit row JSON. Use a
    // BigInt-safe replacer because the chain writer fills `seq` with
    // a BigInt and the default `JSON.stringify` refuses to serialize
    // BigInts — the safety check is on the OTHER fields, not on seq.
    const auditJson = JSON.stringify(data, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    for (const phi of ["Jane", "Doe", "1990-04-15", "(415) 555-0100", "MRN-1"]) {
      expect(auditJson).not.toContain(phi);
    }
  });

  it("outbox event carries only ids and timestamp (no PHI)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "Alice",
          lastName: "Wong",
          dateOfBirth: "1985-11-30",
        },
        { idempotencyKey: "test-key-outbox" }
      )
    );

    const outbox = findOnly(fake.calls, "eventOutbox", "createMany");
    const events = (outbox.args as { data: Array<Record<string, unknown>> }).data;
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event).toMatchObject({
      eventType: "patient.registered.v1",
      aggregateType: "Patient",
      aggregateId: out.patientId,
      organizationId: ORG_ID,
    });

    const payload = event["payload"] as Record<string, unknown>;
    expect(payload).toEqual({
      patientId: out.patientId,
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      occurredAt: "2026-06-01T12:00:00.000Z",
    });

    const payloadJson = JSON.stringify(payload);
    for (const phi of ["Alice", "Wong", "1985-11-30"]) {
      expect(payloadJson).not.toContain(phi);
    }
  });
});

// ---------------------------------------------------------------------
// Decrypt round-trip — what we wrote, we can read back
// ---------------------------------------------------------------------

describe("RegisterPatient — decrypt round-trip", () => {
  it("each *Enc envelope decrypts back to the original plaintext under the row's binding", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "Carlos",
          lastName: "García",
          dateOfBirth: "1972-08-09",
          email: "carlos@example.test",
          mrn: "MRN-42",
        },
        { idempotencyKey: "test-key-roundtrip" }
      )
    );

    const data = (
      findOnly(fake.calls, "patient", "create").args as {
        data: Record<string, unknown>;
      }
    ).data;

    const decryptAt = async (column: string, envelope: unknown): Promise<string> =>
      await decryptField({
        envelope,
        binding: {
          tenantId: ORG_ID,
          table: "patient",
          column,
          recordId: out.patientId,
        },
      });

    expect(await decryptAt("firstName", data["firstNameEnc"])).toBe("Carlos");
    expect(await decryptAt("lastName", data["lastNameEnc"])).toBe("García");
    expect(await decryptAt("dateOfBirth", data["dateOfBirthEnc"])).toBe("1972-08-09");
    expect(await decryptAt("email", data["emailEnc"])).toBe("carlos@example.test");
    expect(await decryptAt("mrn", data["mrnEnc"])).toBe("MRN-42");
  });

  it("decrypting with the wrong recordId fails with AAD_MISMATCH", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "Eve",
          lastName: "Stone",
          dateOfBirth: "2000-01-01",
        },
        { idempotencyKey: "test-key-aad" }
      )
    );

    const data = (
      findOnly(fake.calls, "patient", "create").args as {
        data: Record<string, unknown>;
      }
    ).data;

    await expect(
      decryptField({
        envelope: data["firstNameEnc"],
        binding: {
          tenantId: ORG_ID,
          table: "patient",
          column: "firstName",
          recordId: "00000000-0000-4000-8000-000000000000",
        },
      })
    ).rejects.toMatchObject({ code: "AAD_MISMATCH" });
  });
});

// ---------------------------------------------------------------------
// BI determinism + cross-purpose isolation
// ---------------------------------------------------------------------

describe("RegisterPatient — blind-index properties", () => {
  it("same lastName under the same tenant produces the same lastNameBi across two registrations", async () => {
    const fake1 = buildFakePrisma();
    wireBusAndRbac(fake1.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "Pat",
          lastName: "Smith",
          dateOfBirth: "1980-01-01",
        },
        { idempotencyKey: "bi-k1" }
      )
    );
    const bi1 = (
      findOnly(fake1.calls, "patient", "create").args as {
        data: { lastNameBi: string };
      }
    ).data.lastNameBi;

    // New configuration with the SAME seed → same per-tenant search key.
    resetCommandBusConfigurationForTests();
    resetRbacConfigurationForTests();
    resetCryptoConfigurationForTests();
    configureCrypto({ kms: new LocalKmsAdapter({ seed: "register-patient-test-seed" }) });

    const fake2 = buildFakePrisma();
    wireBusAndRbac(fake2.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "Pat",
          lastName: "Smith",
          dateOfBirth: "1990-12-31",
        },
        { idempotencyKey: "bi-k2" }
      )
    );
    const bi2 = (
      findOnly(fake2.calls, "patient", "create").args as {
        data: { lastNameBi: string };
      }
    ).data.lastNameBi;

    expect(bi1).toBe(bi2);
  });

  it("firstNameBi and lastNameBi for the same word are DIFFERENT (cross-purpose isolation)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "Madison",
          lastName: "Madison",
          dateOfBirth: "1995-07-04",
        },
        { idempotencyKey: "bi-isolate" }
      )
    );

    const data = (
      findOnly(fake.calls, "patient", "create").args as {
        data: { firstNameBi: string; lastNameBi: string };
      }
    ).data;
    expect(data.firstNameBi).not.toBe(data.lastNameBi);
  });

  it("dobBi (YYYYMMDD) and dobYearMonthBi (YYYYMM) for the same DOB are DIFFERENT", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        RegisterPatient,
        {
          clinicId: CLINIC_ID,
          firstName: "X",
          lastName: "Y",
          dateOfBirth: "2001-03-04",
        },
        { idempotencyKey: "bi-dob" }
      )
    );

    const data = (
      findOnly(fake.calls, "patient", "create").args as {
        data: { dobBi: string; dobYearMonthBi: string };
      }
    ).data;
    expect(data.dobBi).not.toBe(data.dobYearMonthBi);
  });
});

// ---------------------------------------------------------------------
// Negative paths
// ---------------------------------------------------------------------

describe("RegisterPatient — clinic not found", () => {
  it("throws ValidationError(PATIENT_CLINIC_NOT_FOUND) and writes no patient row", async () => {
    const fake = buildFakePrisma({ clinicExists: false });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterPatient,
          {
            clinicId: CLINIC_ID,
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "1990-04-15",
          },
          { idempotencyKey: "no-clinic" }
        )
      ).rejects.toMatchObject({ code: "PATIENT_CLINIC_NOT_FOUND" });
    });

    expect(callsOf(fake.calls, "patient", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

describe("RegisterPatient — concurrent clinic deletion", () => {
  it("maps Prisma P2003 FK failure on patient.create to ConflictError(PATIENT_CLINIC_RACE)", async () => {
    const fkErr = new Prisma.PrismaClientKnownRequestError(
      "Foreign key constraint failed on the field: clinicId",
      { code: "P2003", clientVersion: "5.22.0" }
    );
    const fake = buildFakePrisma({ patientCreateError: fkErr });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterPatient,
          {
            clinicId: CLINIC_ID,
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "1990-04-15",
          },
          { idempotencyKey: "race" }
        )
      ).rejects.toMatchObject({ code: "PATIENT_CLINIC_RACE" });
    });
  });
});

describe("RegisterPatient — RBAC", () => {
  it("rejects a caller without patients.create permission", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterPatient,
          {
            clinicId: CLINIC_ID,
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "1990-04-15",
          },
          { idempotencyKey: "no-perm" }
        )
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    // No DB writes at all when RBAC denies.
    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "patient", "create")).toHaveLength(0);
  });
});

describe("RegisterPatient — input validation", () => {
  it("rejects a clinicId that isn't a UUID", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterPatient,
          {
            clinicId: "not-a-uuid",
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "1990-04-15",
          },
          { idempotencyKey: "bad-clinic" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects a malformed dateOfBirth shape", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterPatient,
          {
            clinicId: CLINIC_ID,
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "04/15/1990",
          },
          { idempotencyKey: "bad-dob-shape" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects a calendar-impossible dateOfBirth (e.g. Feb 30)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterPatient,
          {
            clinicId: CLINIC_ID,
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "2026-02-30",
          },
          { idempotencyKey: "bad-dob-cal" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects an invalid email", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterPatient,
          {
            clinicId: CLINIC_ID,
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "1990-04-15",
            email: "not-an-email",
          },
          { idempotencyKey: "bad-email" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects extra fields (strict schema)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterPatient,
          {
            clinicId: CLINIC_ID,
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "1990-04-15",
            socialMediaHandle: "@jane",
          } as never,
          { idempotencyKey: "extra" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects an ssnLast4 that isn't exactly 4 digits", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          RegisterPatient,
          {
            clinicId: CLINIC_ID,
            firstName: "Jane",
            lastName: "Doe",
            dateOfBirth: "1990-04-15",
            ssnLast4: "12345",
          },
          { idempotencyKey: "bad-ssn" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});
