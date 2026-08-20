// Structured-sig dose screening, proven against real Postgres, in the
// two shapes that matter:
//
//   1. THE PATH IS REAL. A prescription with a structured FIXED sig,
//      screened over a knowledge source that DOES declare a dosing
//      envelope (the seeded in-memory source — the stand-in for
//      licensed dosing content), produces a MAJOR dose finding that
//      the PV1 gate refuses to approve past until acknowledged.
//   2. PRODUCTION IS HONEST. The same structured prescription over
//      the REAL composite source with a LIVE (synthetic) RxNorm
//      release resolves the drug — no knowledge gap — and reports
//      `SCR_DOSE_KNOWLEDGE_NOT_PROVISIONED`: dose known, range
//      content not licensed. Informational, gating nothing, and
//      never a silent pass.
//
// Plus the legacy shape (an unstructured prescription reports the
// record-immutable input gap without interrupting) and the database
// constraints that keep a structured sig's shape honest below the
// command layer.
//
// FIXTURES ARE SYNTHETIC by clean-room rule: fake RXCUIs (9xxxxx),
// fake NDCs (99999… labeler space), no real drug name and no real
// dosing figure anywhere in this file.
//
// Requires a running Postgres with migrations applied:
//   pnpm db:up && pnpm db:migrate:deploy && pnpm test:integration

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInMemoryDrugKnowledgeSource,
  findingsRequiringAcknowledgement,
  hardStopFindings,
  type DrugKnowledgeSource,
} from "@pharmax/clinical-screening";
import { prisma, readInOrgScope, type Prisma } from "@pharmax/database";
import { ingestRxnormRelease, loadDrugKnowledgeSourceForScreen } from "@pharmax/drug-knowledge";
import {
  configureClinicalScreening,
  resetClinicalScreeningConfigurationForTests,
  runOrderScreen,
  screeningRefusalForApproval,
} from "@pharmax/verification";

import { connect, assertSchemaReady } from "./lib/db.js";
import { cleanupTenant, seedOrderChain, seedTenant, type SeededTenant } from "./lib/seed.js";
import { disconnectSystemDb, systemDb } from "./support/system-prisma.js";

import type { Client } from "pg";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

const INGREDIENT_RXCUI = "930001";
const COMPONENT_RXCUI = "930002";
const DRUG_RXCUI = "930003";

/** The manufactured product's NDC, normalized 11 digits. */
const DOSED_NDC = "99999200101";

const PHI_PLACEHOLDER = JSON.stringify({ v: "placeholder", alg: "test" });

// --- synthetic RxNorm release, in the public NLM RRF format ---------------

function consoLine(rxcui: string, tty: string, name: string): string {
  const f = new Array<string>(18).fill("");
  f[0] = rxcui;
  f[11] = "RXNORM";
  f[12] = tty;
  f[14] = name;
  f[16] = "N";
  return f.join("|");
}

function relLine(a: string, b: string, rela: string): string {
  const f = new Array<string>(16).fill("");
  f[0] = a;
  f[4] = b;
  f[7] = rela;
  f[10] = "RXNORM";
  return f.join("|");
}

function satLine(rxcui: string, ndc: string): string {
  const f = new Array<string>(13).fill("");
  f[0] = rxcui;
  f[8] = "NDC";
  f[9] = "RXNORM";
  f[10] = ndc;
  return f.join("|");
}

function writeReleaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pharmax-sig-it-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "RXNCONSO.RRF"),
    [
      consoLine(INGREDIENT_RXCUI, "IN", "FIXTURE-DOSE-INGREDIENT"),
      consoLine(COMPONENT_RXCUI, "SCDC", "FIXTURE-DOSE-COMPONENT"),
      consoLine(DRUG_RXCUI, "SCD", "FIXTURE-DOSE-DRUG"),
    ].join("\n") + "\n"
  );
  writeFileSync(
    join(dir, "RXNREL.RRF"),
    [
      relLine(DRUG_RXCUI, COMPONENT_RXCUI, "consists_of"),
      relLine(COMPONENT_RXCUI, INGREDIENT_RXCUI, "has_ingredient"),
    ].join("\n") + "\n"
  );
  writeFileSync(join(dir, "RXNSAT.RRF"), satLine(DRUG_RXCUI, DOSED_NDC) + "\n");
  return dir;
}

// --- tenant-scoped rows ----------------------------------------------------

async function insertProvider(client: Client, tenant: SeededTenant): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO provider (
       id, "organizationId", npi, "firstName", "lastName", status, "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, 'Fixture', 'Prescriber', 'ACTIVE', now(), now())`,
    [id, tenant.organizationId, `17777${String(Math.floor(Math.random() * 90000) + 10000)}`]
  );
  return id;
}

interface StructuredSigFixture {
  readonly kind: "FIXED" | "PRN" | "RANGE" | "TAPER";
  readonly amount: string | null;
  readonly unit: string | null;
  readonly perDay: string | null;
}

async function insertPrescriptionWithLine(
  client: Client,
  tenant: SeededTenant,
  input: {
    orderId: string;
    patientId: string;
    providerId: string;
    drugNdc: string;
    structuredSig?: StructuredSigFixture;
  }
): Promise<string> {
  const prescriptionId = randomUUID();
  const sig = input.structuredSig ?? null;
  await client.query(
    `INSERT INTO prescription (
       id, "organizationId", "clinicId", "patientId", "providerId",
       "rxNumber", "rxNumberBi", "drugNdc", "drugName",
       "quantityAuthorized", "daysSupply", "refillsAuthorized", "refillsRemaining",
       "originalDateWritten", "expiresAt", "sigEnc",
       "sigStructureKind", "doseAmount", "doseUnit", "dosesPerDay",
       status, "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, 'FIXTURE-DRUG-NAME',
       60, 30, 0, 0,
       now(), now() + interval '1 year', $9::jsonb,
       $10::"SigStructureKind", $11, $12::"DoseUnit", $13,
       'ACTIVE', now(), now()
     )`,
    [
      prescriptionId,
      tenant.organizationId,
      tenant.clinicId,
      input.patientId,
      input.providerId,
      `IT-RX-${randomUUID().slice(0, 8)}`,
      `bi-${prescriptionId}`,
      input.drugNdc,
      PHI_PLACEHOLDER,
      sig?.kind ?? null,
      sig?.amount ?? null,
      sig?.unit ?? null,
      sig?.perDay ?? null,
    ]
  );
  await client.query(
    `INSERT INTO order_line (
       id, "organizationId", "clinicId", "orderId", "prescriptionId",
       "quantityToFill", "daysSupplyToFill", "lineStatus", "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, $4, $5, 1, 30, 'PENDING', now(), now())`,
    [randomUUID(), tenant.organizationId, tenant.clinicId, input.orderId, prescriptionId]
  );
  return prescriptionId;
}

async function insertNoKnownAllergiesAssertion(
  client: Client,
  tenant: SeededTenant,
  patientId: string
): Promise<void> {
  await client.query(
    `INSERT INTO patient_allergy_history_assertion (
       id, "organizationId", "clinicId", "patientId", status,
       "assertedByUserId", "assertedAt", "createdAt"
     ) VALUES ($1, $2, $3, $4, 'NO_KNOWN_ALLERGIES', $5, now(), now())`,
    [randomUUID(), tenant.organizationId, tenant.clinicId, patientId, tenant.adminUserId]
  );
}

/**
 * The seeded stand-in for licensed dosing content: knows the drug AND
 * declares a daily maximum below what the fixtures prescribe. Its
 * `doseRangeCoverage` derives to PROVISIONED from the seeded envelope.
 */
function knowledgeWithSeededEnvelope(): DrugKnowledgeSource {
  return createInMemoryDrugKnowledgeSource({
    drugs: {
      [DOSED_NDC]: {
        ingredientCodes: [INGREDIENT_RXCUI],
        uncodedIngredientCount: 0,
        therapeuticClassCodes: [],
        crossSensitivityClassCodes: [],
        doseRange: {
          unit: "mg",
          maxSingleDose: null,
          maxDailyDose: 20,
          minDailyDose: null,
          citation: "synthetic fixture",
        },
      },
    },
  });
}

/** Screen + gate for one order. Injects a source when given one. */
async function screenAndGate(
  tenant: SeededTenant,
  orderId: string,
  patientId: string,
  knowledgeSource?: DrugKnowledgeSource
) {
  return readInOrgScope(tenant.organizationId, async (scoped) => {
    const tx = scoped as unknown as Prisma.TransactionClient;
    const screen = await runOrderScreen({
      tx,
      organizationId: tenant.organizationId,
      orderId,
      patientId,
      policy: { minimumReportedSeverity: "MINOR" },
      ...(knowledgeSource === undefined ? {} : { knowledgeSource }),
    });
    const refusal = await screeningRefusalForApproval({
      tx,
      organizationId: tenant.organizationId,
      orderId,
      patientId,
      pharmacistUserId: tenant.adminUserId,
      evaluation: screen.evaluation,
    });
    return { screen, refusal };
  });
}

// ---------------------------------------------------------------------------

let owner: Client;
let tenant: SeededTenant;

beforeAll(async () => {
  owner = await connect("owner");
  await assertSchemaReady();
  tenant = await seedTenant(owner);

  // A LIVE synthetic release, so the production-shape tests exercise
  // the real composite: the drug RESOLVES (no knowledge gap) while
  // dose-range content honestly does not exist.
  //
  // Written as pharmax_system — the role production's ingestion job
  // holds — because pharmax_app deliberately has no write grant on the
  // global drug-knowledge tables.
  await systemDb().rxnormRelease.deleteMany({});
  await ingestRxnormRelease({ db: systemDb(), directory: writeReleaseDir(), version: "07152026" });

  configureClinicalScreening({
    knowledgeSourceResolver: (context) =>
      loadDrugKnowledgeSourceForScreen({
        tx: context.tx,
        organizationId: context.organizationId,
        drugCodes: context.drugCodes,
      }),
  });
});

afterAll(async () => {
  for (const table of ["order_line", "prescription", "provider"]) {
    await owner.query(`DELETE FROM "${table}" WHERE "organizationId" = $1`, [
      tenant.organizationId,
    ]);
  }
  await cleanupTenant(owner, tenant.organizationId);
  await systemDb().rxnormRelease.deleteMany({});
  await owner.end();
  await disconnectSystemDb();
  await prisma.$disconnect().catch(() => undefined);
  resetClinicalScreeningConfigurationForTests();
});

describe("structured sig over seeded dose knowledge — the path is real", () => {
  it("raises a MAJOR daily-maximum finding that the gate refuses past until acknowledged", async () => {
    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: DOSED_NDC,
      // 10mg x 3/day = 30mg against a 20mg/day seeded maximum.
      structuredSig: { kind: "FIXED", amount: "10", unit: "MG", perDay: "3" },
    });
    await insertNoKnownAllergiesAssertion(owner, tenant, chain.patientId);

    const { screen, refusal } = await screenAndGate(
      tenant,
      chain.orderId,
      chain.patientId,
      knowledgeWithSeededEnvelope()
    );

    // The axis computed: a real clinical finding, acknowledge-tier —
    // never a hard stop, because a dosing range is a population
    // statement.
    expect(screen.evaluation.outcome).toBe("ADVISORY");
    const dose = screen.evaluation.findings.find((f) => f.code === "SCR_DOSE_ABOVE_DAILY_MAXIMUM");
    expect(dose).toMatchObject({
      severity: "MAJOR",
      certainty: "DEFINITE",
      disposition: "REQUIRES_ACKNOWLEDGEMENT",
    });
    expect(dose?.fingerprint).toContain("dailyTotal=30mg");
    expect(hardStopFindings(screen.evaluation)).toEqual([]);
    expect(findingsRequiringAcknowledgement(screen.evaluation).map((f) => f.code)).toEqual([
      "SCR_DOSE_ABOVE_DAILY_MAXIMUM",
    ]);

    // And no gap of any kind on the dose axis: it ran for real.
    const codes = screen.evaluation.findings.map((f) => f.code);
    expect(codes).not.toContain("SCR_DOSE_INPUT_UNAVAILABLE");
    expect(codes).not.toContain("SCR_DOSE_KNOWLEDGE_NOT_PROVISIONED");

    // The gate path: an unacknowledged MAJOR finding refuses approval.
    expect(refusal).toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });
  });
});

describe("structured sig over the real composite — production is honest", () => {
  it("resolves the drug from the live release and reports the dose-range content gap, informationally", async () => {
    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: DOSED_NDC,
      structuredSig: { kind: "FIXED", amount: "10", unit: "MG", perDay: "3" },
    });
    await insertNoKnownAllergiesAssertion(owner, tenant, chain.patientId);

    // No injected source: the REAL composite over the LIVE release.
    const { screen, refusal } = await screenAndGate(tenant, chain.orderId, chain.patientId);

    const codes = screen.evaluation.findings.map((f) => f.code);
    // Gate (a) open, drug known: NOT a drug-knowledge gap and NOT an
    // input gap. What remains is the truth — dose known, range
    // content not licensed.
    expect(codes).not.toContain("SCR_KNOWLEDGE_UNAVAILABLE");
    expect(codes).not.toContain("SCR_DOSE_INPUT_UNAVAILABLE");
    const gap = screen.evaluation.findings.find(
      (f) => f.code === "SCR_DOSE_KNOWLEDGE_NOT_PROVISIONED"
    );
    expect(gap).toMatchObject({
      kind: "SCREENING_GAP",
      severity: "MINOR",
      disposition: "INFORMATIONAL",
    });
    // No dose comparison happened, and none is claimed.
    expect(codes.filter((code) => code.startsWith("SCR_DOSE_ABOVE"))).toEqual([]);
    // Informational, so it gates nothing.
    expect(refusal).toBeNull();
    // And the release attribution rides the screen, as on every axis.
    expect(screen.knowledgeRelease).toMatchObject({ version: "07152026" });
  });

  it("records a legacy unstructured prescription as a record-immutable input gap that gates nothing", async () => {
    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: DOSED_NDC,
      // No structured sig: transcribed before the capture existed.
    });
    await insertNoKnownAllergiesAssertion(owner, tenant, chain.patientId);

    const { screen, refusal } = await screenAndGate(tenant, chain.orderId, chain.patientId);

    const gap = screen.evaluation.findings.find((f) => f.code === "SCR_DOSE_INPUT_UNAVAILABLE");
    expect(gap).toMatchObject({
      kind: "SCREENING_GAP",
      severity: "MINOR",
      disposition: "INFORMATIONAL",
    });
    expect(gap?.fingerprint).toContain("remediation=RECORD_IMMUTABLE");
    // Not the content gap: nothing was comparable, so nothing claims
    // the missing content was the problem.
    expect(screen.evaluation.findings.map((f) => f.code)).not.toContain(
      "SCR_DOSE_KNOWLEDGE_NOT_PROVISIONED"
    );
    expect(refusal).toBeNull();
  });
});

describe("database constraints — the shape rules hold below the command layer", () => {
  async function insertRawPrescription(sig: {
    kind: string | null;
    amount: string | null;
    unit: string | null;
    perDay: string | null;
  }): Promise<void> {
    await owner.query(
      `INSERT INTO prescription (
         id, "organizationId", "clinicId", "patientId", "providerId",
         "rxNumber", "rxNumberBi", "drugNdc", "drugName",
         "quantityAuthorized", "daysSupply", "refillsAuthorized", "refillsRemaining",
         "originalDateWritten", "expiresAt", "sigEnc",
         "sigStructureKind", "doseAmount", "doseUnit", "dosesPerDay",
         status, "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, 'FIXTURE-DRUG-NAME',
         30, 30, 0, 0,
         now(), now() + interval '1 year', $9::jsonb,
         $10::"SigStructureKind", $11, $12::"DoseUnit", $13,
         'ACTIVE', now(), now()
       )`,
      [
        randomUUID(),
        tenant.organizationId,
        tenant.clinicId,
        constraintPatientId,
        constraintProviderId,
        `IT-RX-${randomUUID().slice(0, 8)}`,
        `bi-${randomUUID()}`,
        DOSED_NDC,
        PHI_PLACEHOLDER,
        sig.kind,
        sig.amount,
        sig.unit,
        sig.perDay,
      ]
    );
  }

  let constraintPatientId: string;
  let constraintProviderId: string;

  beforeAll(async () => {
    const chain = await seedOrderChain(owner, tenant);
    constraintPatientId = chain.patientId;
    constraintProviderId = await insertProvider(owner, tenant);
  });

  it("refuses dose values with no structure kind", async () => {
    await expect(
      insertRawPrescription({ kind: null, amount: "10", unit: "MG", perDay: "2" })
    ).rejects.toThrowError(/prescription_structured_sig_shape/);
  });

  it("refuses a FIXED sig missing its frequency", async () => {
    await expect(
      insertRawPrescription({ kind: "FIXED", amount: "10", unit: "MG", perDay: null })
    ).rejects.toThrowError(/prescription_structured_sig_shape/);
  });

  it("refuses a PRN frequency without an amount", async () => {
    await expect(
      insertRawPrescription({ kind: "PRN", amount: null, unit: null, perDay: "4" })
    ).rejects.toThrowError(/prescription_structured_sig_shape/);
  });

  it("refuses a non-positive dose amount", async () => {
    await expect(
      insertRawPrescription({ kind: "FIXED", amount: "0", unit: "MG", perDay: "1" })
    ).rejects.toThrowError(/prescription_dose_amount_positive/);
  });

  it("accepts a bare TAPER — structured and honestly numberless", async () => {
    await expect(
      insertRawPrescription({ kind: "TAPER", amount: null, unit: null, perDay: null })
    ).resolves.toBeUndefined();
  });
});
