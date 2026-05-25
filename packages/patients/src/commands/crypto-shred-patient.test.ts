// CryptoShredPatient contract tests.
//
// The first destructive PHI command in the platform. The tests pin:
//
//   1. The storage shape — every `*Enc` and every `*Bi` column is
//      NULLed in a SINGLE updateMany, the row is flipped to INACTIVE,
//      and `cryptoShreddedAt` is stamped with the bus's clock.
//   2. The CAS predicate — the updateMany filters on
//      `cryptoShreddedAt: null` so a concurrent shred winning the
//      race surfaces as `PATIENT_SHRED_RACE_LOST` rather than
//      partial state.
//   3. PHI invariants — `command_log.requestPayload` carries no PHI
//      because the input has none, audit metadata is presence
//      booleans + reason + commandLogId only, outbox payload is ids
//      + reason + timestamp only.
//   4. The double-shred guard — repeated shreds are REJECTED (not
//      silently idempotent) with `PATIENT_ALREADY_SHREDDED` and the
//      first-shred timestamp.
//   5. RBAC — `patients.crypto_shred` is required; absence
//      short-circuits the bus before any DB write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureCommandBus,
  executeCommand,
  resetCommandBusConfigurationForTests,
} from "@pharmax/command-bus";
import {
  CRYPTO_SHRED_REASONS,
  configureCrypto,
  LocalKmsAdapter,
  resetCryptoConfigurationForTests,
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

import { CryptoShredPatient } from "./crypto-shred-patient.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CLINIC_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PATIENT_ID = "44444444-4444-4444-8444-444444444444";
const FROZEN_NOW = new Date("2026-06-01T12:00:00.000Z");

const shredGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PATIENTS_CRYPTO_SHRED]),
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

// Shape returned by `tx.patient.findUnique`. Only the columns we
// actually select in the handler need to be present.
interface PatientReadRow {
  id: string;
  cryptoShreddedAt: Date | null;
  middleNameEnc: unknown;
  sexAtBirthEnc: unknown;
  ssnLast4Enc: unknown;
  phoneEnc: unknown;
  emailEnc: unknown;
  addressLine1Enc: unknown;
  addressLine2Enc: unknown;
  cityEnc: unknown;
  stateEnc: unknown;
  postalCodeEnc: unknown;
  mrnEnc: unknown;
}

interface FakePrismaOptions {
  /** Row the handler will read. Set to `null` to exercise the not-found path. */
  patientRow?: PatientReadRow | null;
  /** Count `patient.updateMany` returns. Set to 0 to exercise the race-lost path. */
  updateCount?: number;
}

// Use multi-character unique markers so the no-leak substring
// assertions are meaningful (single-letter sentinels collide with
// JSON syntax and base64 alphabet).
const ENVELOPE_STUB = {
  v: 1,
  alg: "AES-256-GCM",
  kek: "kek-marker-XYZ",
  wDek: "wdek-marker-XYZ",
  iv: "iv-marker-XYZ",
  ct: "ct-marker-XYZ",
  tag: "tag-marker-XYZ",
};

function buildPatientRow(overrides: Partial<PatientReadRow> = {}): PatientReadRow {
  return {
    id: PATIENT_ID,
    cryptoShreddedAt: null,
    middleNameEnc: null,
    sexAtBirthEnc: null,
    ssnLast4Enc: null,
    phoneEnc: null,
    emailEnc: null,
    addressLine1Enc: null,
    addressLine2Enc: null,
    cityEnc: null,
    stateEnc: null,
    postalCodeEnc: null,
    mrnEnc: null,
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
  // CryptoShredPatient doesn't actually call encryptField/blindIndex,
  // but `planCryptoShred` validates against the closed reason
  // registry and configureCrypto sanity-checks the boot singleton
  // for any future change that does use crypto here.
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "crypto-shred-patient-test-seed" }) });
});

afterEach(() => {
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
});

function wireBusAndRbac(client: unknown, grants: ReadonlyArray<ResolvedGrant> = shredGrants): void {
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
// Happy path — minimal patient (required identity only)
// ---------------------------------------------------------------------

describe("CryptoShredPatient — happy path (minimal patient)", () => {
  it("NULLs every Enc + Bi column, stamps cryptoShreddedAt, flips status to INACTIVE", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    const out = await withTenancyContext(ctx(), () =>
      executeCommand(
        CryptoShredPatient,
        { patientId: PATIENT_ID, reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN },
        { idempotencyKey: "shred-key-min" }
      )
    );

    expect(out).toEqual({
      patientId: PATIENT_ID,
      cryptoShreddedAt: FROZEN_NOW.toISOString(),
      reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN,
    });

    // Exactly one updateMany — the CAS path.
    const update = findOnly(fake.calls, "patient", "updateMany");
    const args = update.args as {
      where: { id: string; organizationId: string; cryptoShreddedAt: null };
      data: Record<string, unknown>;
    };

    // CAS predicate: id + organizationId + cryptoShreddedAt: null.
    expect(args.where).toEqual({
      id: PATIENT_ID,
      organizationId: ORG_ID,
      cryptoShreddedAt: null,
    });

    // Every PHI envelope column gets Prisma.DbNull — the sentinel
    // that writes SQL NULL into a Json column. Plain TS `null` would
    // store the JSON literal `null`, which is a different value.
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
      expect(args.data[k]).toBe(Prisma.DbNull);
    }

    // Every blind-index column (plain TEXT?) gets TS null.
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
      expect(args.data[k]).toBeNull();
    }

    // Tombstone stamped with the frozen clock.
    expect(args.data["cryptoShreddedAt"]).toEqual(FROZEN_NOW);

    // Status flipped to INACTIVE.
    expect(args.data["status"]).toBe(PatientStatus.INACTIVE);
  });
});

// ---------------------------------------------------------------------
// Audit + outbox shape — PHI-free with presence booleans
// ---------------------------------------------------------------------

describe("CryptoShredPatient — audit + outbox shape", () => {
  it("audit metadata records reason + presence booleans + commandLogId (no PHI)", async () => {
    // Patient row WITH every optional field set so `had*` booleans
    // exercise the true branch.
    const fake = buildFakePrisma({
      patientRow: buildPatientRow({
        middleNameEnc: ENVELOPE_STUB,
        sexAtBirthEnc: ENVELOPE_STUB,
        ssnLast4Enc: ENVELOPE_STUB,
        phoneEnc: ENVELOPE_STUB,
        emailEnc: ENVELOPE_STUB,
        addressLine1Enc: ENVELOPE_STUB,
        cityEnc: ENVELOPE_STUB,
        stateEnc: ENVELOPE_STUB,
        postalCodeEnc: ENVELOPE_STUB,
        mrnEnc: ENVELOPE_STUB,
      }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        CryptoShredPatient,
        { patientId: PATIENT_ID, reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN },
        { idempotencyKey: "shred-audit-full" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const data = (audit.args as { data: Record<string, unknown> }).data;

    expect(data["action"]).toBe("patient.crypto_shredded");
    expect(data["resourceType"]).toBe("Patient");
    expect(data["resourceId"]).toBe(PATIENT_ID);

    const metadata = data["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN,
      hadMrn: true,
      hadSsnLast4: true,
      hadPhone: true,
      hadEmail: true,
      hadAddress: true,
      hadMiddleName: true,
      hadSexAtBirth: true,
    });

    // shreddedEncColumns + shreddedBiColumns surface the structural
    // scope of the shred without disclosing any value.
    expect(metadata["shreddedEncColumns"]).toEqual(
      expect.arrayContaining(["firstNameEnc", "lastNameEnc", "dateOfBirthEnc", "mrnEnc"])
    );
    expect(metadata["shreddedBiColumns"]).toEqual(
      expect.arrayContaining(["firstNameBi", "lastNameBi", "dobBi", "dobYearMonthBi", "mrnBi"])
    );

    // No envelope ciphertext leaks even in transit through the
    // audit row JSON. BigInt-safe replacer for the chain's `seq`.
    const auditJson = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(auditJson).not.toContain(ENVELOPE_STUB.ct);
    expect(auditJson).not.toContain(ENVELOPE_STUB.tag);
    expect(auditJson).not.toContain(ENVELOPE_STUB.wDek);
  });

  it("had* booleans are FALSE when the row had no optional PHI", async () => {
    const fake = buildFakePrisma(); // default row: every optional column null.
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        CryptoShredPatient,
        { patientId: PATIENT_ID, reason: CRYPTO_SHRED_REASONS.TENANT_OFFBOARD },
        { idempotencyKey: "shred-audit-min" }
      )
    );

    const audit = findOnly(fake.calls, "auditLog", "create");
    const metadata = (audit.args as { data: { metadata: Record<string, unknown> } }).data.metadata;

    expect(metadata).toMatchObject({
      reason: CRYPTO_SHRED_REASONS.TENANT_OFFBOARD,
      hadMrn: false,
      hadSsnLast4: false,
      hadPhone: false,
      hadEmail: false,
      hadAddress: false,
      hadMiddleName: false,
      hadSexAtBirth: false,
    });
  });

  it("outbox event carries ids + reason + timestamp only (no PHI)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        CryptoShredPatient,
        { patientId: PATIENT_ID, reason: CRYPTO_SHRED_REASONS.DATA_RETENTION_EXPIRY },
        { idempotencyKey: "shred-outbox" }
      )
    );

    const outbox = findOnly(fake.calls, "eventOutbox", "createMany");
    const events = (outbox.args as { data: Array<Record<string, unknown>> }).data;
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event).toMatchObject({
      eventType: "patient.crypto_shredded.v1",
      aggregateType: "Patient",
      aggregateId: PATIENT_ID,
      organizationId: ORG_ID,
    });

    const payload = event["payload"] as Record<string, unknown>;
    expect(payload).toEqual({
      patientId: PATIENT_ID,
      organizationId: ORG_ID,
      reason: CRYPTO_SHRED_REASONS.DATA_RETENTION_EXPIRY,
      occurredAt: FROZEN_NOW.toISOString(),
    });

    // The `toEqual` assertion above already pins the payload to
    // exactly {patientId, organizationId, reason, occurredAt}, so
    // no PHI can land here without the test failing. The extra
    // substring guard catches a regression where someone adds a
    // sibling field carrying a clinic id or DOB.
    const payloadJson = JSON.stringify(payload);
    expect(payloadJson).not.toContain(CLINIC_ID);
  });
});

// ---------------------------------------------------------------------
// command_log.requestPayload — the input has no PHI so it survives
// ---------------------------------------------------------------------

describe("CryptoShredPatient — command_log requestPayload", () => {
  it("records the non-PHI input verbatim (no redaction applied)", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), () =>
      executeCommand(
        CryptoShredPatient,
        { patientId: PATIENT_ID, reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN },
        { idempotencyKey: "shred-cmdlog" }
      )
    );

    const cmdLogCreate = findOnly(fake.calls, "commandLog", "create");
    const payload = (cmdLogCreate.args as { data: { requestPayload: Record<string, unknown> } })
      .data.requestPayload;

    expect(payload).toEqual({
      patientId: PATIENT_ID,
      reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN,
    });
  });
});

// ---------------------------------------------------------------------
// Negative paths — guards + races
// ---------------------------------------------------------------------

describe("CryptoShredPatient — patient not found", () => {
  it("throws NotFoundError(PATIENT_NOT_FOUND) and writes nothing", async () => {
    const fake = buildFakePrisma({ patientRow: null });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          CryptoShredPatient,
          { patientId: PATIENT_ID, reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN },
          { idempotencyKey: "shred-missing" }
        )
      ).rejects.toMatchObject({ code: "PATIENT_NOT_FOUND" });
    });

    expect(callsOf(fake.calls, "patient", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

describe("CryptoShredPatient — already shredded", () => {
  it("throws ConflictError(PATIENT_ALREADY_SHREDDED) with firstShreddedAt and writes nothing", async () => {
    const firstShreddedAt = new Date("2026-05-01T08:30:00.000Z");
    const fake = buildFakePrisma({
      patientRow: buildPatientRow({ cryptoShreddedAt: firstShreddedAt }),
    });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          CryptoShredPatient,
          { patientId: PATIENT_ID, reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN },
          { idempotencyKey: "shred-twice" }
        )
      ).rejects.toMatchObject({
        code: "PATIENT_ALREADY_SHREDDED",
        metadata: {
          patientId: PATIENT_ID,
          firstShreddedAt: firstShreddedAt.toISOString(),
        },
      });
    });

    expect(callsOf(fake.calls, "patient", "updateMany")).toHaveLength(0);
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
  });
});

describe("CryptoShredPatient — concurrent shred race", () => {
  it("maps updateMany count=0 to ConflictError(PATIENT_SHRED_RACE_LOST)", async () => {
    const fake = buildFakePrisma({ updateCount: 0 });
    wireBusAndRbac(fake.client);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          CryptoShredPatient,
          { patientId: PATIENT_ID, reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN },
          { idempotencyKey: "shred-race" }
        )
      ).rejects.toMatchObject({ code: "PATIENT_SHRED_RACE_LOST" });
    });

    // Audit + outbox MUST NOT have been written.
    expect(callsOf(fake.calls, "auditLog", "create")).toHaveLength(0);
    expect(callsOf(fake.calls, "eventOutbox", "createMany")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------

describe("CryptoShredPatient — RBAC", () => {
  it("rejects a caller without patients.crypto_shred and writes nothing", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client, readOnlyGrants);

    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          CryptoShredPatient,
          { patientId: PATIENT_ID, reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN },
          { idempotencyKey: "shred-no-perm" }
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

describe("CryptoShredPatient — input validation", () => {
  it("rejects a non-UUID patientId", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          CryptoShredPatient,
          { patientId: "not-a-uuid", reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN },
          { idempotencyKey: "bad-pid" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });

  it("rejects a reason outside the closed registry", async () => {
    const fake = buildFakePrisma();
    wireBusAndRbac(fake.client);
    await withTenancyContext(ctx(), async () => {
      await expect(
        executeCommand(
          CryptoShredPatient,
          { patientId: PATIENT_ID, reason: "made-up-reason" as never },
          { idempotencyKey: "bad-reason" }
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
          CryptoShredPatient,
          {
            patientId: PATIENT_ID,
            reason: CRYPTO_SHRED_REASONS.RIGHT_TO_BE_FORGOTTEN,
            sneakyExtra: true,
          } as never,
          { idempotencyKey: "extra" }
        )
      ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
    });
  });
});

// ---------------------------------------------------------------------
// Reason vocabulary — every registered reason succeeds
// ---------------------------------------------------------------------

describe("CryptoShredPatient — every registered reason is accepted", () => {
  for (const reason of Object.values(CRYPTO_SHRED_REASONS)) {
    it(`accepts reason ${reason}`, async () => {
      const fake = buildFakePrisma();
      wireBusAndRbac(fake.client);
      await withTenancyContext(ctx(), () =>
        executeCommand(
          CryptoShredPatient,
          { patientId: PATIENT_ID, reason },
          { idempotencyKey: `reason-${reason}` }
        )
      );
      const audit = findOnly(fake.calls, "auditLog", "create");
      const metadata = (audit.args as { data: { metadata: { reason: string } } }).data.metadata;
      expect(metadata.reason).toBe(reason);
    });
  }
});
