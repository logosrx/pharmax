// CreatePrescription contract tests.
//
// Two things are being pinned here, and they fail for different
// reasons.
//
// The SAFETY properties are the point of the command: the DEA
// schedule comes from the catalog and not from whoever is typing, a
// prescriber without a DEA registration cannot authorize a controlled
// substance, refill counts are checked against 21 CFR part 1306 at
// issuance, and the Rx number comes from the allocator. Every one of
// these has a test that asserts the write did NOT happen, because a
// validation that throws after persisting is not a validation.
//
// The PHI properties are inherited from `RegisterPatient` and tested
// the same way: the sig round-trips through real crypto, the audit
// metadata and the outbox payload contain no clinical free text, and
// the command log redacts it.
//
// Prisma is faked so the suite stays DB-free, but the KMS adapter is
// real — mocking crypto here would test the mock.

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
} from "@pharmax/crypto";
import {
  ControlledSubstanceSchedule,
  CredentialStatus,
  Prisma,
  RoleScope,
} from "@pharmax/database";
import { clock, logger } from "@pharmax/platform-core";
import {
  configureRbac,
  InMemoryPermissionLoader,
  PERMISSIONS,
  resetRbacConfigurationForTests,
  type ResolvedGrant,
} from "@pharmax/rbac";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";

import { PRESCRIPTION_BLIND_INDEX } from "../blind-indexes.js";
import { CreatePrescription } from "./create-prescription.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CLINIC_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PATIENT_ID = "44444444-4444-4444-8444-444444444444";
const PROVIDER_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_CLINIC_ID = "66666666-6666-4666-8666-666666666666";

// "now" for the frozen clock. Every date fixture is relative to this.
const NOW = new Date("2026-06-01T12:00:00.000Z");

const NDC_LISINOPRIL = "00093505601";
const NDC_OXYCODONE = "00406055201";

const SIG = "Take one tablet by mouth once daily";

const tenantGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.PRESCRIPTIONS_CREATE]),
  },
];

const readOnlyGrants: ReadonlyArray<ResolvedGrant> = [
  {
    roleScope: RoleScope.ORGANIZATION,
    grantScope: { siteId: null, clinicId: null, teamId: null },
    permissions: new Set([PERMISSIONS.ORDERS_READ]),
  },
];

function ctx() {
  return buildTenancyContext({
    organizationId: ORG_ID,
    actor: { userId: USER_ID, correlationId: "01CORRELATION0000000000000" },
  });
}

/** Minimal valid input; every test overrides only what it is about. */
function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clinicId: CLINIC_ID,
    patientId: PATIENT_ID,
    providerId: PROVIDER_ID,
    drugNdc: NDC_LISINOPRIL,
    drugName: "Lisinopril",
    quantityAuthorized: "30",
    daysSupply: 30,
    refillsAuthorized: 3,
    originalDateWritten: "2026-05-20",
    sig: SIG,
    ...overrides,
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

/**
 * The default prescriber credential: live, no recorded expiry, every
 * controlled schedule. That is exactly what the superseded
 * `Provider.deaNumber` column conferred, so tests written against the
 * old presence check keep meaning what they meant.
 */
const ACTIVE_DEA_REGISTRATION = Object.freeze({
  deaNumber: "AB1234563",
  status: CredentialStatus.ACTIVE,
  expiresAt: null,
  authorizedSchedules: [
    ControlledSubstanceSchedule.CII,
    ControlledSubstanceSchedule.CIII,
    ControlledSubstanceSchedule.CIV,
    ControlledSubstanceSchedule.CV,
  ] as ReadonlyArray<ControlledSubstanceSchedule>,
});

interface FakePrismaOptions {
  clinicExists?: boolean;
  patient?: { clinicId: string; status: string } | null;
  provider?: {
    status: string;
    deaRegistrations: ReadonlyArray<{
      deaNumber: string;
      status: CredentialStatus;
      expiresAt: Date | null;
      authorizedSchedules: ReadonlyArray<ControlledSubstanceSchedule>;
    }>;
  } | null;
  /** Catalog entry for every NDC looked up, or null for "uncatalogued". */
  product?: { controlledSubstanceSchedule: ControlledSubstanceSchedule } | null;
  /** Counter value the allocator's upsert returns. */
  nextRxValue?: number;
  prescriptionCreateError?: Error;
}

function buildFakePrisma(opts: FakePrismaOptions = {}): { client: unknown; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const clinicExists = opts.clinicExists !== false;
  const patient =
    opts.patient === undefined ? { clinicId: CLINIC_ID, status: "ACTIVE" } : opts.patient;
  const provider =
    opts.provider === undefined
      ? { status: "ACTIVE", deaRegistrations: [ACTIVE_DEA_REGISTRATION] }
      : opts.provider;
  const product =
    opts.product === undefined
      ? { controlledSubstanceSchedule: ControlledSubstanceSchedule.NON_CONTROLLED }
      : opts.product;

  const tx = {
    clinic: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "clinic", op: "findUnique", args });
        if (!clinicExists) return null;
        return { id: (args as { where: { id: string } }).where.id };
      }),
    },
    patient: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "patient", op: "findUnique", args });
        if (patient === null) return null;
        return { id: PATIENT_ID, ...patient };
      }),
    },
    provider: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "provider", op: "findUnique", args });
        if (provider === null) return null;
        return { id: PROVIDER_ID, ...provider };
      }),
    },
    product: {
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ table: "product", op: "findUnique", args });
        return product;
      }),
    },
    rxNumberSequence: {
      upsert: vi.fn(async (args: unknown) => {
        calls.push({ table: "rxNumberSequence", op: "upsert", args });
        return { lastValue: opts.nextRxValue ?? 1 };
      }),
      update: vi.fn(async (args: unknown) => {
        calls.push({ table: "rxNumberSequence", op: "update", args });
        return { lastValue: opts.nextRxValue ?? 1 };
      }),
    },
    prescription: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ table: "prescription", op: "create", args });
        if (opts.prescriptionCreateError !== undefined) throw opts.prescriptionCreateError;
        return (args as { data: { id: string } }).data;
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
        return { count: (args as { data: unknown[] }).data.length };
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
    $executeRaw: vi.fn(async (template: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({
        table: "$executeRaw",
        op: "raw",
        args: { sql: template.join("?"), values: [...values] },
      });
      return 0;
    }),
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
  if (m.length !== 1) throw new Error(`Expected exactly one ${table}.${op}, got ${m.length}`);
  return m[0] as FakeCall;
}

function createdRow(calls: FakeCall[]): Record<string, unknown> {
  return (findOnly(calls, "prescription", "create").args as { data: Record<string, unknown> }).data;
}

let keyCounter = 0;
function run(input: Record<string, unknown>) {
  keyCounter += 1;
  return withTenancyContext(ctx(), () =>
    executeCommand(CreatePrescription, input as never, {
      idempotencyKey: `create-rx-${String(keyCounter)}`,
    })
  );
}

function wire(client: unknown, grants: ReadonlyArray<ResolvedGrant> = tenantGrants): void {
  configureCommandBus({
    prisma: client as unknown as Parameters<typeof configureCommandBus>[0]["prisma"],
    clock: clock.createFrozenClock(NOW),
    logger: logger.noopLogger,
  });
  configureRbac({
    loader: new InMemoryPermissionLoader([{ organizationId: ORG_ID, userId: USER_ID, grants }]),
  });
}

/**
 * `JSON.stringify` that survives the audit chain's BigInt sequence
 * number. Used for "this string must not appear anywhere in the row"
 * assertions, where scanning the whole serialized object is the point.
 */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/** Assert nothing was written — the shape every rejection test wants. */
function expectNoWrites(calls: FakeCall[]): void {
  expect(callsOf(calls, "prescription", "create")).toHaveLength(0);
  expect(callsOf(calls, "auditLog", "create")).toHaveLength(0);
  expect(callsOf(calls, "eventOutbox", "createMany")).toHaveLength(0);
}

beforeEach(() => {
  configureCrypto({ kms: new LocalKmsAdapter({ seed: "create-prescription-test-seed" }) });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCommandBusConfigurationForTests();
  resetRbacConfigurationForTests();
  resetCryptoConfigurationForTests();
});

// ---------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------

describe("CreatePrescription — happy path", () => {
  it("writes the prescription with an allocated Rx number and an encrypted sig", async () => {
    const fake = buildFakePrisma({ nextRxValue: 42 });
    wire(fake.client);

    const out = await run(validInput());

    expect(out.rxNumber).toBe("0000042");
    expect(out.controlledSubstanceSchedule).toBe(ControlledSubstanceSchedule.NON_CONTROLLED);
    expect(out.prescriptionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    const data = createdRow(fake.calls);
    expect(data["id"]).toBe(out.prescriptionId);
    expect(data["organizationId"]).toBe(ORG_ID);
    expect(data["rxNumber"]).toBe("0000042");
    expect(data["status"]).toBe("ACTIVE");
    expect(data["sigEnc"]).toMatchObject({ v: 1, alg: "AES-256-GCM" });

    // Refills start full: remaining is authorized, not zero.
    expect(data["refillsAuthorized"]).toBe(3);
    expect(data["refillsRemaining"]).toBe(3);

    // Optional clinical columns are omitted, not written as null.
    for (const k of [
      "noteToPharmacistEnc",
      "noteToPatientEnc",
      "indicationEnc",
      "earliestFillDate",
    ]) {
      expect(data[k]).toBeUndefined();
    }
  });

  it("blind-indexes the Rx number to a 43-char base64url digest", async () => {
    const fake = buildFakePrisma({ nextRxValue: 7 });
    wire(fake.client);

    await run(validInput());

    const bi = createdRow(fake.calls)["rxNumberBi"];
    expect(typeof bi).toBe("string");
    expect((bi as string).length).toBe(43);
    expect(bi as string).toMatch(/^[A-Za-z0-9_-]+$/);

    // Same value through the search-side helper must produce the same
    // digest, or lookups by Rx number silently return nothing.
    const searchSide = await PRESCRIPTION_BLIND_INDEX.rxNumber({
      tenantId: ORG_ID,
      value: "0000007",
    });
    expect(searchSide).toBe(bi);
  });

  it("round-trips the sig through real crypto with the row-bound AAD", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await run(validInput());
    const data = createdRow(fake.calls);

    const plaintext = await decryptField({
      envelope: data["sigEnc"] as never,
      binding: {
        tenantId: ORG_ID,
        table: "prescription",
        column: "sig",
        recordId: out.prescriptionId,
      },
    });
    expect(plaintext).toBe(SIG);
  });

  it("normalizes a hyphenated 10-digit NDC before storing and looking it up", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    // 5-4-1 shape: the padding zero belongs in the PACKAGE segment.
    await run(validInput({ drugNdc: "00093-5056-1" }));

    expect(createdRow(fake.calls)["drugNdc"]).toBe("00093505601");
    const lookup = findOnly(fake.calls, "product", "findUnique").args as {
      where: { organizationId_ndc: { ndc: string } };
    };
    expect(lookup.where.organizationId_ndc.ndc).toBe("00093505601");
  });

  it("stores the optional clinical fields encrypted when supplied", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await run(
      validInput({
        noteToPharmacist: "Patient prefers non-child-resistant caps",
        noteToPatient: "Take with food",
        indication: "Hypertension",
        drugStrength: "10 mg",
        drugForm: "tablet",
      })
    );

    const data = createdRow(fake.calls);
    for (const k of ["noteToPharmacistEnc", "noteToPatientEnc", "indicationEnc"]) {
      expect(data[k]).toMatchObject({ v: 1, alg: "AES-256-GCM" });
    }
    expect(data["drugStrength"]).toBe("10 mg");
  });
});

// ---------------------------------------------------------------------
// Expiry derivation
// ---------------------------------------------------------------------

describe("CreatePrescription — expiry", () => {
  it("defaults a non-controlled prescription to one year from the date written", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await run(validInput({ originalDateWritten: "2026-05-20" }));

    expect(out.expiresAt).toBe("2027-05-20");
  });

  it("defaults a controlled prescription to six months from the date written", async () => {
    const fake = buildFakePrisma({
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CIV },
    });
    wire(fake.client);

    const out = await run(
      validInput({
        drugNdc: NDC_OXYCODONE,
        originalDateWritten: "2026-05-20",
        refillsAuthorized: 2,
      })
    );

    expect(out.expiresAt).toBe("2026-11-20");
  });

  it("honours an explicit expiry inside the allowed window", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await run(validInput({ expiresAt: "2026-08-01" }));

    expect(out.expiresAt).toBe("2026-08-01");
  });
});

// ---------------------------------------------------------------------
// Schedule resolution — the catalog is the source of truth
// ---------------------------------------------------------------------

describe("CreatePrescription — DEA schedule resolution", () => {
  it("takes the schedule from the catalog when the caller does not state one", async () => {
    const fake = buildFakePrisma({
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CII },
    });
    wire(fake.client);

    const out = await run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 0 }));

    expect(out.controlledSubstanceSchedule).toBe(ControlledSubstanceSchedule.CII);
    expect(createdRow(fake.calls)["controlledSubstanceSchedule"]).toBe("CII");
  });

  it("rejects a declared schedule that disagrees with the catalog", async () => {
    const fake = buildFakePrisma({
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CII },
    });
    wire(fake.client);

    await expect(
      run(
        validInput({
          drugNdc: NDC_OXYCODONE,
          controlledSubstanceSchedule: "NON_CONTROLLED",
          refillsAuthorized: 0,
        })
      )
    ).rejects.toMatchObject({ code: "RX_SCHEDULE_CATALOG_MISMATCH" });

    expectNoWrites(fake.calls);
  });

  it("accepts a declared schedule that agrees with the catalog", async () => {
    const fake = buildFakePrisma({
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CIV },
    });
    wire(fake.client);

    const out = await run(
      validInput({ drugNdc: NDC_OXYCODONE, controlledSubstanceSchedule: "CIV" })
    );

    expect(out.controlledSubstanceSchedule).toBe(ControlledSubstanceSchedule.CIV);
  });

  it("requires an explicit schedule when the NDC is not in the catalog", async () => {
    const fake = buildFakePrisma({ product: null });
    wire(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "RX_SCHEDULE_REQUIRED_FOR_UNKNOWN_NDC",
    });

    expectNoWrites(fake.calls);
  });

  it("uses the declared schedule when the NDC is not in the catalog", async () => {
    const fake = buildFakePrisma({ product: null });
    wire(fake.client);

    const out = await run(validInput({ controlledSubstanceSchedule: "NON_CONTROLLED" }));

    expect(out.controlledSubstanceSchedule).toBe(ControlledSubstanceSchedule.NON_CONTROLLED);
    const audit = findOnly(fake.calls, "auditLog", "create").args as {
      data: { metadata: Record<string, unknown> };
    };
    expect(audit.data.metadata["scheduleSource"]).toBe("declared");
  });
});

// ---------------------------------------------------------------------
// Controlled-substance authorization limits
// ---------------------------------------------------------------------

describe("CreatePrescription — 21 CFR part 1306 authorization limits", () => {
  it("refuses any refill on a Schedule II prescription", async () => {
    const fake = buildFakePrisma({
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CII },
    });
    wire(fake.client);

    await expect(
      run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 1 }))
    ).rejects.toMatchObject({ code: "RX_CONTROLLED_AUTHORIZATION_INVALID" });

    expectNoWrites(fake.calls);
  });

  it("allows zero refills on a Schedule II prescription", async () => {
    const fake = buildFakePrisma({
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CII },
    });
    wire(fake.client);

    const out = await run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 0 }));

    expect(out.controlledSubstanceSchedule).toBe(ControlledSubstanceSchedule.CII);
  });

  it("caps Schedule III/IV refills at five", async () => {
    const fake = buildFakePrisma({
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CIII },
    });
    wire(fake.client);

    await expect(
      run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 6 }))
    ).rejects.toMatchObject({ code: "RX_CONTROLLED_AUTHORIZATION_INVALID" });

    expectNoWrites(fake.calls);
  });

  it("does not cap refills on a non-controlled prescription", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await run(validInput({ refillsAuthorized: 11 }));

    expect(out.prescriptionId).toBeTruthy();
  });

  it("refuses a controlled prescription from a prescriber with no DEA registration", async () => {
    const fake = buildFakePrisma({
      provider: { status: "ACTIVE", deaRegistrations: [] },
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CIV },
    });
    wire(fake.client);

    await expect(
      run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 0 }))
    ).rejects.toMatchObject({
      code: "RX_PROVIDER_DEA_REQUIRED",
      metadata: { reason: "DEA_AUTHORITY_NO_REGISTRATION" },
    });

    expectNoWrites(fake.calls);
  });

  it("refuses a controlled prescription when the registration has expired", async () => {
    // The old presence check could not see this at all: a lapsed
    // registration is still a non-blank string.
    const fake = buildFakePrisma({
      provider: {
        status: "ACTIVE",
        deaRegistrations: [
          { ...ACTIVE_DEA_REGISTRATION, expiresAt: new Date("2026-01-01T00:00:00.000Z") },
        ],
      },
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CIV },
    });
    wire(fake.client);

    await expect(
      run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 0 }))
    ).rejects.toMatchObject({
      code: "RX_PROVIDER_DEA_REQUIRED",
      metadata: { reason: "DEA_AUTHORITY_EXPIRED" },
    });
    expectNoWrites(fake.calls);
  });

  it("refuses a controlled prescription when the registration is revoked", async () => {
    const fake = buildFakePrisma({
      provider: {
        status: "ACTIVE",
        deaRegistrations: [{ ...ACTIVE_DEA_REGISTRATION, status: CredentialStatus.REVOKED }],
      },
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CIV },
    });
    wire(fake.client);

    await expect(
      run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 0 }))
    ).rejects.toMatchObject({
      code: "RX_PROVIDER_DEA_REQUIRED",
      metadata: { reason: "DEA_AUTHORITY_NOT_ACTIVE" },
    });
    expectNoWrites(fake.calls);
  });

  it("refuses a schedule the registration does not authorize", async () => {
    // Live, unexpired, and limited to CIII-CV. A mid-level prescriber
    // whose state does not grant CII authority is the real case.
    const fake = buildFakePrisma({
      provider: {
        status: "ACTIVE",
        deaRegistrations: [
          {
            ...ACTIVE_DEA_REGISTRATION,
            authorizedSchedules: [
              ControlledSubstanceSchedule.CIII,
              ControlledSubstanceSchedule.CIV,
              ControlledSubstanceSchedule.CV,
            ],
          },
        ],
      },
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CII },
    });
    wire(fake.client);

    await expect(
      run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 0 }))
    ).rejects.toMatchObject({
      code: "RX_PROVIDER_DEA_REQUIRED",
      metadata: { reason: "DEA_AUTHORITY_SCHEDULE_NOT_AUTHORIZED" },
    });
    expectNoWrites(fake.calls);
  });

  it("allows a controlled prescription when a second registration covers the schedule", async () => {
    // A prescriber may hold more than one number; only one of them
    // needs to authorize.
    const fake = buildFakePrisma({
      provider: {
        status: "ACTIVE",
        deaRegistrations: [
          { ...ACTIVE_DEA_REGISTRATION, authorizedSchedules: [ControlledSubstanceSchedule.CV] },
          ACTIVE_DEA_REGISTRATION,
        ],
      },
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CIV },
    });
    wire(fake.client);

    const out = await run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 0 }));
    expect(out.prescriptionId).toBeTruthy();
  });

  it("allows a controlled prescription when no expiry was ever recorded", async () => {
    // A pharmacy migrating on has numbers and no dates. Treating that
    // as expired would take every tenant's controlled prescribing
    // offline on the day this shipped.
    const fake = buildFakePrisma({
      provider: {
        status: "ACTIVE",
        deaRegistrations: [{ ...ACTIVE_DEA_REGISTRATION, expiresAt: null }],
      },
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CIV },
    });
    wire(fake.client);

    const out = await run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 0 }));
    expect(out.prescriptionId).toBeTruthy();
  });

  it("allows a non-controlled prescription from a prescriber with no DEA registration", async () => {
    const fake = buildFakePrisma({ provider: { status: "ACTIVE", deaRegistrations: [] } });
    wire(fake.client);

    const out = await run(validInput());

    expect(out.prescriptionId).toBeTruthy();
  });

  it("rejects a Schedule III expiry beyond the six-month federal horizon", async () => {
    const fake = buildFakePrisma({
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CIII },
    });
    wire(fake.client);

    await expect(
      run(
        validInput({
          drugNdc: NDC_OXYCODONE,
          refillsAuthorized: 1,
          originalDateWritten: "2026-05-20",
          expiresAt: "2026-11-21",
        })
      )
    ).rejects.toMatchObject({ code: "RX_EXPIRY_EXCEEDS_FEDERAL_HORIZON" });

    expectNoWrites(fake.calls);
  });

  it("does not apply the six-month horizon to Schedule V", async () => {
    // § 1306.22(a) names III and IV only. Treating CV as if it were
    // covered is the most common way to get this wrong.
    const fake = buildFakePrisma({
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CV },
    });
    wire(fake.client);

    const out = await run(
      validInput({
        drugNdc: NDC_OXYCODONE,
        originalDateWritten: "2026-05-20",
        expiresAt: "2027-05-20",
      })
    );

    expect(out.expiresAt).toBe("2027-05-20");
  });
});

// ---------------------------------------------------------------------
// Reference-data validation
// ---------------------------------------------------------------------

describe("CreatePrescription — reference data", () => {
  it("rejects an unknown clinic", async () => {
    const fake = buildFakePrisma({ clinicExists: false });
    wire(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "RX_CLINIC_NOT_FOUND",
    });
    expectNoWrites(fake.calls);
  });

  it("rejects an unknown patient", async () => {
    const fake = buildFakePrisma({ patient: null });
    wire(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "RX_PATIENT_NOT_FOUND",
    });
    expectNoWrites(fake.calls);
  });

  it("rejects a patient who belongs to a different clinic", async () => {
    const fake = buildFakePrisma({ patient: { clinicId: OTHER_CLINIC_ID, status: "ACTIVE" } });
    wire(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "RX_PATIENT_CLINIC_MISMATCH",
    });
    expectNoWrites(fake.calls);
  });

  it("rejects a deceased patient", async () => {
    const fake = buildFakePrisma({ patient: { clinicId: CLINIC_ID, status: "DECEASED" } });
    wire(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "RX_PATIENT_NOT_ACTIVE",
    });
    expectNoWrites(fake.calls);
  });

  it("rejects an unknown prescriber", async () => {
    const fake = buildFakePrisma({ provider: null });
    wire(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "RX_PROVIDER_NOT_FOUND",
    });
    expectNoWrites(fake.calls);
  });

  it("rejects an inactive prescriber", async () => {
    const fake = buildFakePrisma({
      provider: { status: "INACTIVE", deaRegistrations: [ACTIVE_DEA_REGISTRATION] },
    });
    wire(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "RX_PROVIDER_INACTIVE",
    });
    expectNoWrites(fake.calls);
  });

  it("rejects an NDC that is neither 10 nor 11 digits", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(run(validInput({ drugNdc: "12345" }))).rejects.toMatchObject({
      code: "RX_NDC_INVALID",
    });
    expectNoWrites(fake.calls);
  });
});

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------

describe("CreatePrescription — dates", () => {
  it("rejects a date written in the future", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(run(validInput({ originalDateWritten: "2026-06-02" }))).rejects.toMatchObject({
      code: "RX_DATE_WRITTEN_IN_FUTURE",
    });
    expectNoWrites(fake.calls);
  });

  it("accepts a prescription written today", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    const out = await run(validInput({ originalDateWritten: "2026-06-01" }));

    expect(out.prescriptionId).toBeTruthy();
  });

  it("rejects an expiry that is not after the date written", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(run(validInput({ expiresAt: "2026-05-20" }))).rejects.toMatchObject({
      code: "RX_EXPIRES_NOT_AFTER_WRITTEN",
    });
    expectNoWrites(fake.calls);
  });

  it("rejects a do-not-fill-before date earlier than the date written", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(run(validInput({ earliestFillDate: "2026-05-19" }))).rejects.toMatchObject({
      code: "RX_EARLIEST_FILL_BEFORE_WRITTEN",
    });
    expectNoWrites(fake.calls);
  });

  it("stores a do-not-fill-before date on or after the date written", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await run(validInput({ earliestFillDate: "2026-06-20" }));

    expect(createdRow(fake.calls)["earliestFillDate"]).toEqual(new Date("2026-06-20T00:00:00Z"));
  });

  it("rejects a calendar date that does not exist", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(run(validInput({ originalDateWritten: "2026-02-30" }))).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
    });
  });
});

// ---------------------------------------------------------------------
// Allocation and persistence failures
// ---------------------------------------------------------------------

describe("CreatePrescription — allocation and persistence", () => {
  it("allocates the Rx number only after every validation has passed", async () => {
    // A rejected transcription must not burn a number, and must not
    // hold the clinic's counter lock while it fails.
    const fake = buildFakePrisma({ provider: { status: "INACTIVE", deaRegistrations: [] } });
    wire(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "RX_PROVIDER_INACTIVE",
    });

    expect(callsOf(fake.calls, "rxNumberSequence", "upsert")).toHaveLength(0);
  });

  it("increments the clinic's counter through the composite key", async () => {
    const fake = buildFakePrisma({ nextRxValue: 5 });
    wire(fake.client);

    await run(validInput());

    const upsert = findOnly(fake.calls, "rxNumberSequence", "upsert").args as {
      where: { organizationId_clinicId: { organizationId: string; clinicId: string } };
      create: { lastValue: number };
      update: { lastValue: { increment: number } };
    };
    expect(upsert.where.organizationId_clinicId).toEqual({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
    });
    expect(upsert.create.lastValue).toBe(1);
    expect(upsert.update.lastValue).toEqual({ increment: 1 });
  });

  it("surfaces a unique-constraint collision on the Rx number as a conflict", async () => {
    const fake = buildFakePrisma({
      prescriptionCreateError: new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    });
    wire(fake.client);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "RX_NUMBER_COLLISION",
    });
  });

  it("fails loudly rather than writing NULL when the Rx blind index resolves null", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);
    vi.spyOn(PRESCRIPTION_BLIND_INDEX, "rxNumber").mockResolvedValue(null);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "RX_BI_REQUIRED_NULL",
    });
    expectNoWrites(fake.calls);
  });
});

// ---------------------------------------------------------------------
// Structured sig
// ---------------------------------------------------------------------

describe("CreatePrescription — structured sig", () => {
  it("persists a FIXED structured sig and names the kind in the audit metadata", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await run(
      validInput({
        sigStructureKind: "FIXED",
        doseAmount: "1",
        doseUnit: "TABLET",
        dosesPerDay: "1",
      })
    );

    const row = createdRow(fake.calls);
    expect(row["sigStructureKind"]).toBe("FIXED");
    expect(row["doseAmount"]).toEqual(new Prisma.Decimal("1"));
    expect(row["doseUnit"]).toBe("TABLET");
    expect(row["dosesPerDay"]).toEqual(new Prisma.Decimal("1"));

    // The kind is a coded workflow fact and belongs on the audit row;
    // the dose VALUES do not — the row's reader asks whether capture
    // happened, not what the regimen was.
    const audit = findOnly(fake.calls, "auditLog", "create").args as {
      data: { metadata: Record<string, unknown> };
    };
    expect(audit.data.metadata["sigStructureKind"]).toBe("FIXED");
    expect(audit.data.metadata).not.toHaveProperty("doseAmount");
  });

  it("leaves every structured column unset for an unstructured transcription", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await run(validInput());

    const row = createdRow(fake.calls);
    expect(row).not.toHaveProperty("sigStructureKind");
    expect(row).not.toHaveProperty("doseAmount");
    const audit = findOnly(fake.calls, "auditLog", "create").args as {
      data: { metadata: Record<string, unknown> };
    };
    expect(audit.data.metadata["sigStructureKind"]).toBeNull();
  });

  it("rejects dose values that arrive without a structure kind", async () => {
    // An amount with no kind has no defined reading — FIXED's "the
    // regimen" and RANGE's "the upper bound" are different claims.
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      run(validInput({ doseAmount: "1", doseUnit: "TABLET", dosesPerDay: "1" }))
    ).rejects.toMatchObject({ code: "RX_STRUCTURED_SIG_SHAPE_INVALID" });
    expectNoWrites(fake.calls);
  });

  it("rejects a FIXED sig missing any of amount, unit or frequency", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      run(validInput({ sigStructureKind: "FIXED", doseAmount: "1", doseUnit: "TABLET" }))
    ).rejects.toMatchObject({ code: "RX_STRUCTURED_SIG_SHAPE_INVALID" });
    expectNoWrites(fake.calls);
  });

  it("accepts a bare PRN — structured, with no comparable number, is an honest state", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await run(validInput({ sigStructureKind: "PRN" }));

    const row = createdRow(fake.calls);
    expect(row["sigStructureKind"]).toBe("PRN");
    expect(row).not.toHaveProperty("doseAmount");
  });

  it("rejects a PRN frequency ceiling without a dose amount", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      run(validInput({ sigStructureKind: "PRN", dosesPerDay: "4" }))
    ).rejects.toMatchObject({ code: "RX_STRUCTURED_SIG_SHAPE_INVALID" });
    expectNoWrites(fake.calls);
  });

  it("rejects an amount without its unit, whatever the kind", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      run(validInput({ sigStructureKind: "PRN", doseAmount: "10" }))
    ).rejects.toMatchObject({ code: "RX_STRUCTURED_SIG_SHAPE_INVALID" });
    expectNoWrites(fake.calls);
  });

  it("rejects a frequency beyond hourly dosing at the schema boundary", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      run(
        validInput({
          sigStructureKind: "FIXED",
          doseAmount: "1",
          doseUnit: "TABLET",
          dosesPerDay: "25",
        })
      )
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });

  it("rejects a FIXED sig whose arithmetic contradicts the days supply", async () => {
    // 30 tablets at 2 x 2/day lasts 7.5 days, not the stated 30 —
    // one of the four numbers was mistranscribed, and this is the
    // last moment the operator is holding the script.
    const fake = buildFakePrisma();
    wire(fake.client);

    await expect(
      run(
        validInput({
          sigStructureKind: "FIXED",
          doseAmount: "2",
          doseUnit: "TABLET",
          dosesPerDay: "2",
        })
      )
    ).rejects.toMatchObject({ code: "RX_STRUCTURED_SIG_DAYS_SUPPLY_INCONSISTENT" });
    expectNoWrites(fake.calls);
  });

  it("tolerates insurance-cycle rounding in the cross-check", async () => {
    // "Dispense 30, 28 days supply" is routine, not a transcription
    // error; the band is 2x either way so rounding never trips it.
    const fake = buildFakePrisma();
    wire(fake.client);

    await run(
      validInput({
        daysSupply: 28,
        sigStructureKind: "FIXED",
        doseAmount: "1",
        doseUnit: "TABLET",
        dosesPerDay: "1",
      })
    );

    expect(createdRow(fake.calls)["daysSupply"]).toBe(28);
  });

  it("does not cross-check a dose in a unit the quantity is not denominated in", async () => {
    // 30 units of SOMETHING against 500mg x 2/day is a category
    // error, not an inconsistency — without the product's strength
    // the arithmetic proves nothing either way.
    const fake = buildFakePrisma();
    wire(fake.client);

    await run(
      validInput({
        sigStructureKind: "FIXED",
        doseAmount: "500",
        doseUnit: "MG",
        dosesPerDay: "2",
      })
    );

    expect(createdRow(fake.calls)["doseUnit"]).toBe("MG");
  });

  it("does not cross-check a RANGE — its upper bound legitimately implies a shorter duration", async () => {
    // "1–2 tablets daily, 30 tablets, 30 days supply": at the maximum
    // the supply lasts 15 days, and that is the prescription working
    // as written, not an error.
    const fake = buildFakePrisma();
    wire(fake.client);

    await run(
      validInput({
        sigStructureKind: "RANGE",
        doseAmount: "2",
        doseUnit: "TABLET",
        dosesPerDay: "1",
      })
    );

    expect(createdRow(fake.calls)["sigStructureKind"]).toBe("RANGE");
  });
});

// ---------------------------------------------------------------------
// PHI invariants
// ---------------------------------------------------------------------

describe("CreatePrescription — PHI invariants", () => {
  it("keeps clinical free text out of the audit metadata and the outbox payload", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await run(
      validInput({
        noteToPharmacist: "SECRET-PHARMACIST-NOTE",
        noteToPatient: "SECRET-PATIENT-NOTE",
        indication: "SECRET-INDICATION",
      })
    );

    const audit = findOnly(fake.calls, "auditLog", "create").args;
    const outbox = findOnly(fake.calls, "eventOutbox", "createMany").args;

    for (const serialized of [stringify(audit), stringify(outbox)]) {
      expect(serialized).not.toContain(SIG);
      expect(serialized).not.toContain("SECRET-PHARMACIST-NOTE");
      expect(serialized).not.toContain("SECRET-PATIENT-NOTE");
      expect(serialized).not.toContain("SECRET-INDICATION");
    }

    // Presence booleans are what the audit records instead.
    const metadata = (audit as { data: { metadata: Record<string, unknown> } }).data.metadata;
    expect(metadata["hasNoteToPharmacist"]).toBe(true);
    expect(metadata["hasIndication"]).toBe(true);
  });

  it("redacts clinical free text from the command log request payload", async () => {
    const fake = buildFakePrisma();
    wire(fake.client);

    await run(validInput({ indication: "SECRET-INDICATION" }));

    const logged = JSON.stringify(callsOf(fake.calls, "commandLog", "create").map((c) => c.args));
    expect(logged).not.toContain(SIG);
    expect(logged).not.toContain("SECRET-INDICATION");
    // The drug identity IS retained — the log has to be able to say
    // what was transcribed.
    expect(logged).toContain("Lisinopril");
  });

  it("emits exactly one prescription.created.v1 event carrying ids and the schedule", async () => {
    const fake = buildFakePrisma({
      product: { controlledSubstanceSchedule: ControlledSubstanceSchedule.CIV },
    });
    wire(fake.client);

    const out = await run(validInput({ drugNdc: NDC_OXYCODONE, refillsAuthorized: 2 }));

    const rows = (
      findOnly(fake.calls, "eventOutbox", "createMany").args as {
        data: Array<{ eventType: string; aggregateId: string; payload: Record<string, unknown> }>;
      }
    ).data;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("prescription.created.v1");
    expect(rows[0]?.aggregateId).toBe(out.prescriptionId);
    expect(rows[0]?.payload).toMatchObject({
      prescriptionId: out.prescriptionId,
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      patientId: PATIENT_ID,
      providerId: PROVIDER_ID,
      drugNdc: NDC_OXYCODONE,
      controlledSubstanceSchedule: "CIV",
      refillsAuthorized: 2,
    });
  });
});

// ---------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------

describe("CreatePrescription — RBAC", () => {
  it("denies a caller without prescriptions.create", async () => {
    const fake = buildFakePrisma();
    wire(fake.client, readOnlyGrants);

    await expect(run(validInput())).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    expect(callsOf(fake.calls, "commandLog", "create")).toHaveLength(0);
    expectNoWrites(fake.calls);
  });
});
