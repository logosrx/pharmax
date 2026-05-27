// UpdatePatient contract tests.
//
// The second PHI-bearing patient command. Tests pin:
//
//   1. Selective re-encryption — only the columns the input names
//      get written; unaddressed columns are untouched.
//   2. Bi coupling — every `*Enc` column move drags its partner
//      `*Bi` column along; DOB updates BOTH dobBi and dobYearMonthBi.
//   3. Tri-state semantics — `undefined`, `null`, and `string` each
//      produce different on-disk effects (untouched, Prisma.DbNull
//      cleared, encrypted+indexed).
//   4. Locked-out guards — shredded or merged patients refuse
//      updates with typed conflict codes; not-found surfaces 404.
//   5. CAS race — `updateMany` count=0 maps to
//      PATIENT_UPDATE_RACE_LOST and writes no audit / outbox.
//   6. PHI invariants — `command_log.requestPayload` has every PHI
//      key censored, audit metadata is the structural diff +
//      clinicId only, outbox payload is ids + diff + timestamp.
//   7. RBAC — `patients.update` is required; absence short-circuits.
//
// We mock Prisma so the suite stays DB-free, but use a REAL
// `LocalKmsAdapter` so encryption + blindIndex code paths execute
// for real (mocked crypto would not catch a corrupted AAD binding).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  configureCrypto,
  decryptField,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
  type CiphertextEnvelope,
} from "@pharmax/crypto";
import { PatientStatus, Prisma, RoleScope } from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { UpdatePatient } from "./update-patient.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CLINIC_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PATIENT_ID = "44444444-4444-4444-8444-444444444444";
const SURVIVOR_PATIENT_ID = "55555555-5555-4555-8555-555555555555";
const FROZEN_NOW = new Date("2026-06-15T09:00:00.000Z");

const updateGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PATIENTS_UPDATE]),
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
// Fake Prisma — records every call.
// ---------------------------------------------------------------------

interface FakeCall {
  table: string;
  op: string;
  args: unknown;
}

interface PatientReadRow {
  id: string;
  clinicId: string;
  status: PatientStatus;
  cryptoShreddedAt: Date | null;
  mergedIntoPatientId: string | null;
}

interface FakePrismaOptions {
  /** Row returned by `patient.findUnique`. `null` exercises not-found. */
  patientRow?: PatientReadRow | null;
  /** Count returned by `patient.updateMany`. 0 exercises race-lost. */
  updateCount?: number;
}

function buildPatientRow(overrides: Partial<PatientReadRow> = {}): PatientReadRow {
  return {
    id: PATIENT_ID,
    clinicId: CLINIC_ID,
    status: PatientStatus.ACTIVE,
    cryptoShreddedAt: null,
    mergedIntoPatientId: null,
    ...overrides,
  };
}

function buildFakePrisma(opts: FakePrismaOptions = {}): {
  client: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const updateCount = opts.updateCount ?? 1;
  const row = opts.patientRow === undefined ? buildPatientRow() : opts.patientRow;

  const tx = {
    patient: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "patient", op: "findUnique", args });
        return row;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        calls.push({ table: "patient", op: "updateMany", args });
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

// ---------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------

beforeEach(() => {
  // REAL crypto. The same seed is used across the suite so envelope
  // round-trips work and AAD bindings stay consistent.
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "update-patient-test-seed" }) });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
});

function wireBusAndRbac(
  client: unknown,
  grants: ReadonlyArray<ResolvedGrant> = updateGrants
): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(FROZEN_NOW),
    logger: logger.noopLogger,
  });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
}

// ---------------------------------------------------------------------
// Happy path — minimal update (lastName only)
// ---------------------------------------------------------------------

describe("UpdatePatient — happy path (single field)", () => {
  it("writes only the named column + its Bi partner; leaves everything else untouched", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        { patientId: PATIENT_ID, lastName: "Carmichael" },
        { idempotencyKey: "update-lastname" }
      )
    );

    expect(out).toEqual({
      patientId: PATIENT_ID,
      updatedAt: FROZEN_NOW.toISOString(),
      updatedFields: ["lastName"],
      clearedFields: [],
    });

    const update = findOnly(fake.calls, "patient", "updateMany");
    const args = update.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };

    // CAS predicate locks out shredded + merged rows.
    expect(args.where).toEqual({
      id: PATIENT_ID,
      organizationId: ORG_ID,
      cryptoShreddedAt: null,
      status: { not: PatientStatus.MERGED },
    });

    // Only lastName columns were written.
    expect(Object.keys(args.data).sort()).toEqual(["lastNameBi", "lastNameEnc"]);
    expect(args.data["lastNameEnc"]).toBeTruthy();
    expect(args.data["lastNameBi"]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url

    // Critically: firstName, dateOfBirth, and every other column are
    // ABSENT from the update payload (not set to null, just not there).
    expect(args.data["firstNameEnc"]).toBeUndefined();
    expect(args.data["dateOfBirthEnc"]).toBeUndefined();
    expect(args.data["middleNameEnc"]).toBeUndefined();
    expect(args.data["phoneEnc"]).toBeUndefined();
    expect(args.data["dobBi"]).toBeUndefined();
    expect(args.data["dobYearMonthBi"]).toBeUndefined();
  });

  it("re-encrypting the same plaintext yields a fresh envelope (random IV per call)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        { patientId: PATIENT_ID, lastName: "Mendoza" },
        { idempotencyKey: "update-1" }
      )
    );

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        { patientId: PATIENT_ID, lastName: "Mendoza" },
        { idempotencyKey: "update-2" }
      )
    );

    const updates = callsOf(fake.calls, "patient", "updateMany");
    expect(updates).toHaveLength(2);

    const env1 = (updates[0]!.args as { data: { lastNameEnc: CiphertextEnvelope } }).data
      .lastNameEnc;
    const env2 = (updates[1]!.args as { data: { lastNameEnc: CiphertextEnvelope } }).data
      .lastNameEnc;
    expect(env1.iv).not.toBe(env2.iv);
    expect(env1.ct).not.toBe(env2.ct);

    // Same plaintext → same Bi (deterministic HMAC, search depends on it).
    const bi1 = (updates[0]!.args as { data: { lastNameBi: string } }).data.lastNameBi;
    const bi2 = (updates[1]!.args as { data: { lastNameBi: string } }).data.lastNameBi;
    expect(bi1).toBe(bi2);
  });

  it("encrypted column round-trips through the AAD binding (patientId === recordId)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        { patientId: PATIENT_ID, firstName: "Esperanza" },
        { idempotencyKey: "update-firstname" }
      )
    );

    const update = findOnly(fake.calls, "patient", "updateMany");
    const env = (update.args as { data: { firstNameEnc: CiphertextEnvelope } }).data.firstNameEnc;

    const plain = await decryptField({
      envelope: env,
      binding: {
        tenantId: ORG_ID,
        table: "patient",
        column: "firstName",
        recordId: PATIENT_ID,
      },
    });
    expect(plain).toBe("Esperanza");
  });
});

// ---------------------------------------------------------------------
// Happy path — DOB update refreshes BOTH dobBi and dobYearMonthBi
// ---------------------------------------------------------------------

describe("UpdatePatient — DOB update refreshes both DOB blind indexes", () => {
  it("writes dateOfBirthEnc + dobBi + dobYearMonthBi together", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        { patientId: PATIENT_ID, dateOfBirth: "1985-11-22" },
        { idempotencyKey: "update-dob" }
      )
    );

    const update = findOnly(fake.calls, "patient", "updateMany");
    const data = (update.args as { data: Record<string, unknown> }).data;

    expect(Object.keys(data).sort()).toEqual(["dateOfBirthEnc", "dobBi", "dobYearMonthBi"]);
    expect(data["dobBi"]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(data["dobYearMonthBi"]).toMatch(/^[A-Za-z0-9_-]+$/);
    // The two BIs differ — they hash different normalized inputs
    // ("19851122" vs "198511").
    expect(data["dobBi"]).not.toBe(data["dobYearMonthBi"]);
  });
});

// ---------------------------------------------------------------------
// Happy path — clearing optional fields
// ---------------------------------------------------------------------

describe("UpdatePatient — clearing optional fields with null", () => {
  it("writes Prisma.DbNull to a non-searchable optional Enc column", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        { patientId: PATIENT_ID, middleName: null },
        { idempotencyKey: "clear-middle" }
      )
    );

    expect(out.updatedFields).toEqual([]);
    expect(out.clearedFields).toEqual(["middleName"]);

    const update = findOnly(fake.calls, "patient", "updateMany");
    const data = (update.args as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual(["middleNameEnc"]);
    expect(data["middleNameEnc"]).toBe(Prisma.DbNull);
  });

  it("clears a searchable field's Enc (DbNull) AND its Bi (null) in the same write", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        { patientId: PATIENT_ID, phone: null, email: null },
        { idempotencyKey: "clear-contact" }
      )
    );

    const update = findOnly(fake.calls, "patient", "updateMany");
    const data = (update.args as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(["emailBi", "emailEnc", "phoneEnc", "phoneLast10Bi"]);
    expect(data["phoneEnc"]).toBe(Prisma.DbNull);
    expect(data["phoneLast10Bi"]).toBeNull();
    expect(data["emailEnc"]).toBe(Prisma.DbNull);
    expect(data["emailBi"]).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Happy path — full update (every PHI field, mix of sets and clears)
// ---------------------------------------------------------------------

describe("UpdatePatient — full update across every PHI field", () => {
  it("writes every Enc column the input names and pairs Bi columns where applicable", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        {
          patientId: PATIENT_ID,
          firstName: "Esperanza",
          lastName: "Carmichael",
          dateOfBirth: "1985-11-22",
          middleName: "Ines",
          sexAtBirth: "FEMALE",
          ssnLast4: "0001",
          phone: "(555) 555-1234",
          email: "esperanza.carmichael@example.test",
          addressLine1: "100 Main Street",
          addressLine2: "Apt 4B",
          city: "Springfield",
          state: "IL",
          postalCode: "62704-1234",
          mrn: "MRN-001",
        },
        { idempotencyKey: "update-full" }
      )
    );

    // updatedFields is sorted alphabetically; clearedFields is empty.
    expect(out.updatedFields).toEqual([
      "addressLine1",
      "addressLine2",
      "city",
      "dateOfBirth",
      "email",
      "firstName",
      "lastName",
      "middleName",
      "mrn",
      "phone",
      "postalCode",
      "sexAtBirth",
      "ssnLast4",
      "state",
    ]);
    expect(out.clearedFields).toEqual([]);

    const update = findOnly(fake.calls, "patient", "updateMany");
    const data = (update.args as { data: Record<string, unknown> }).data;

    // Every Enc column was written.
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
      expect(data[k]).toBeTruthy();
      // No Prisma.DbNull anywhere — every value is a real envelope.
      expect(data[k]).not.toBe(Prisma.DbNull);
    }

    // Every searchable Bi column was written, including BOTH dobBi
    // and dobYearMonthBi because dateOfBirth was provided.
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
      expect(data[k]).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

// ---------------------------------------------------------------------
// Audit + outbox shape
// ---------------------------------------------------------------------

describe("UpdatePatient — audit + outbox shape (PHI-free)", () => {
  it("audit metadata records clinicId + structural diff + commandLogId (no PHI values)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        {
          patientId: PATIENT_ID,
          firstName: "Esperanza",
          phone: null,
          mrn: "MRN-NEW",
        },
        { idempotencyKey: "audit-shape" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const auditData = (audit.args as { data: Record<string, unknown> }).data;

    expect(auditData["action"]).toBe("patient.updated");
    expect(auditData["resourceType"]).toBe("Patient");
    expect(auditData["resourceId"]).toBe(PATIENT_ID);

    const metadata = auditData["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      clinicId: CLINIC_ID,
      updatedFields: ["firstName", "mrn"],
      clearedFields: ["phone"],
    });
    expect(metadata["commandLogId"]).toBeTypeOf("string");

    // No PHI values in audit. Spot-check by substring on the full
    // JSON. BigInt-safe replacer for chain seq numbers.
    const auditJson = JSON.stringify(auditData, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    expect(auditJson).not.toContain("Esperanza");
    expect(auditJson).not.toContain("MRN-NEW");
  });

  it("outbox payload carries ids + structural diff + timestamp only", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        { patientId: PATIENT_ID, lastName: "Quintero", email: null },
        { idempotencyKey: "outbox-shape" }
      )
    );

    const outbox = findOnly(fake.calls, "eventOutbox", "createMany");
    const events = (outbox.args as { data: Array<Record<string, unknown>> }).data;
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event).toMatchObject({
      eventType: "patient.updated.v1",
      aggregateType: "Patient",
      aggregateId: PATIENT_ID,
      organizationId: ORG_ID,
    });

    const payload = event["payload"] as Record<string, unknown>;
    expect(payload).toEqual({
      patientId: PATIENT_ID,
      organizationId: ORG_ID,
      updatedFields: ["lastName"],
      clearedFields: ["email"],
      occurredAt: FROZEN_NOW.toISOString(),
    });

    // Belt-and-suspenders: no plaintext values, no clinicId, no DOB.
    const payloadJson = JSON.stringify(payload);
    expect(payloadJson).not.toContain("Quintero");
    expect(payloadJson).not.toContain(CLINIC_ID);
  });
});

// ---------------------------------------------------------------------
// command_log.requestPayload redaction
// ---------------------------------------------------------------------

describe("UpdatePatient — command_log redaction", () => {
  it("replaces every PHI field in command_log.requestPayload with [Redacted]", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        UpdatePatient,
        {
          patientId: PATIENT_ID,
          firstName: "Esperanza",
          lastName: "Carmichael",
          dateOfBirth: "1985-11-22",
          phone: "(555) 555-1234",
          email: "e@example.test",
          mrn: "MRN-001",
          middleName: null, // cleared — bus redacts the null too
        },
        { idempotencyKey: "cmdlog-redact" }
      )
    );

    const cmdLogCreate = findOnly(fake.calls, "commandLog", "create");
    const payload = (cmdLogCreate.args as { data: { requestPayload: Record<string, unknown> } })
      .data.requestPayload;

    // patientId is NOT PHI and must survive verbatim.
    expect(payload["patientId"]).toBe(PATIENT_ID);

    // Every PHI key — value or null — is censored.
    for (const k of [
      "firstName",
      "lastName",
      "dateOfBirth",
      "phone",
      "email",
      "mrn",
      "middleName",
    ]) {
      expect(payload[k]).toBe("[Redacted]");
    }
  });
});

// ---------------------------------------------------------------------
// Negative paths — guards + races
// ---------------------------------------------------------------------

describe("UpdatePatient — empty change set", () => {
  it("throws ValidationError(PATIENT_UPDATE_NO_CHANGES) and writes nothing domain-side", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID },
          { idempotencyKey: "empty-changes" }
        )
      ).rejects.toMatchObject({ code: "PATIENT_UPDATE_NO_CHANGES" });
    });

    // No domain reads or writes. The bus may have created a
    // command_log row to record the failed attempt; that's not a
    // domain write.
    expect(callsOf(fake.calls, "patient", "findUnique")).toHaveLength(0);
    expect(callsOf(fake.calls, "patient", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

describe("UpdatePatient — patient not found", () => {
  it("throws NotFoundError(PATIENT_NOT_FOUND) and writes nothing", async () => {
    const fake = buildFakePrisma({ patientRow: null });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID, lastName: "X" },
          { idempotencyKey: "not-found" }
        )
      ).rejects.toMatchObject({ code: "PATIENT_NOT_FOUND" });
    });

    expect(callsOf(fake.calls, "patient", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

describe("UpdatePatient — crypto-shredded", () => {
  it("throws ConflictError(PATIENT_SHREDDED) with cryptoShreddedAt and writes nothing", async () => {
    const cryptoShreddedAt = new Date("2026-05-01T08:30:00.000Z");
    const fake = buildFakePrisma({
      patientRow: buildPatientRow({
        cryptoShreddedAt,
        status: PatientStatus.INACTIVE,
      }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID, mrn: "MRN-NEW" },
          { idempotencyKey: "shredded" }
        )
      ).rejects.toMatchObject({
        code: "PATIENT_SHREDDED",
        metadata: {
          patientId: PATIENT_ID,
          cryptoShreddedAt: cryptoShreddedAt.toISOString(),
        },
      });
    });

    expect(callsOf(fake.calls, "patient", "updateMany")).toHaveLength(0);
  });
});

describe("UpdatePatient — merged away", () => {
  it("throws ConflictError(PATIENT_MERGED_AWAY) with mergedIntoPatientId and writes nothing", async () => {
    const fake = buildFakePrisma({
      patientRow: buildPatientRow({
        status: PatientStatus.MERGED,
        mergedIntoPatientId: SURVIVOR_PATIENT_ID,
      }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID, lastName: "X" },
          { idempotencyKey: "merged" }
        )
      ).rejects.toMatchObject({
        code: "PATIENT_MERGED_AWAY",
        metadata: {
          patientId: PATIENT_ID,
          mergedIntoPatientId: SURVIVOR_PATIENT_ID,
        },
      });
    });

    expect(callsOf(fake.calls, "patient", "updateMany")).toHaveLength(0);
  });
});

describe("UpdatePatient — CAS race lost", () => {
  it("maps updateMany count=0 to ConflictError(PATIENT_UPDATE_RACE_LOST) with no audit/outbox", async () => {
    const fake = buildFakePrisma({ updateCount: 0 });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID, lastName: "X" },
          { idempotencyKey: "race-lost" }
        )
      ).rejects.toMatchObject({ code: "PATIENT_UPDATE_RACE_LOST" });
    });

    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------

describe("UpdatePatient — RBAC", () => {
  it("rejects a caller without patients.update and writes nothing", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID, lastName: "X" },
          { idempotencyKey: "no-perm" }
        )
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "patient", "findUnique")).toHaveLength(0);
    expect(callsOf(fake.calls, "patient", "updateMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------

describe("UpdatePatient — input validation", () => {
  const grantedFake = () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
    return fake;
  };

  it("rejects a non-UUID patientId", async () => {
    grantedFake();
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: "not-a-uuid", lastName: "X" },
          { idempotencyKey: "bad-uuid" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects null on an identity field (cannot clear firstName)", async () => {
    grantedFake();
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID, firstName: null as never },
          { idempotencyKey: "null-firstname" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects a calendar-invalid DOB", async () => {
    grantedFake();
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID, dateOfBirth: "2026-02-30" },
          { idempotencyKey: "bad-dob" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects a malformed state code", async () => {
    grantedFake();
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID, state: "illinois" },
          { idempotencyKey: "bad-state" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects an empty string on an optional field (must use null to clear)", async () => {
    grantedFake();
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID, middleName: "" },
          { idempotencyKey: "empty-mid" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects extra fields (strict schema)", async () => {
    grantedFake();
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          UpdatePatient,
          { patientId: PATIENT_ID, lastName: "X", sneaky: true } as never,
          { idempotencyKey: "extra-field" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});
