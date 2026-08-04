// The RxNorm drug-knowledge source, proven against real Postgres:
// versioned atomic loads, ingestion idempotency, the refuse-older
// guard, adapter correctness — and the path the whole workstream
// exists for, a seeded ingredient allergy hard-stopping a PV1
// approval through the REAL adapter and the REAL gate.
//
// FIXTURES ARE SYNTHETIC by clean-room rule: the RRF lines below use
// fake RXCUIs (9xxxxx) and fake NDCs (99999… labeler space) in the
// PUBLIC NLM file format. No line appears in any actual release, and
// no real drug name occurs anywhere in this file.
//
// Requires a running Postgres with migrations applied:
//   pnpm db:up && pnpm db:migrate:deploy && pnpm test:integration

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hardStopFindings } from "@pharmax/clinical-screening";
import { prisma, readInOrgScope, type Prisma } from "@pharmax/database";
import {
  ingestRxnormRelease,
  loadRxnormKnowledgeSourceForScreen,
  RxnormIngestError,
  RXNORM_INGEST_ERRORS,
  RXNORM_KNOWLEDGE_SOURCE_CODE,
} from "@pharmax/drug-knowledge";
import {
  configureClinicalScreening,
  resetClinicalScreeningConfigurationForTests,
  runOrderScreen,
  screeningRefusalForApproval,
} from "@pharmax/verification";

import { assertSchemaReady, connect } from "./lib/db.js";
import { cleanupTenant, seedOrderChain, seedTenant, type SeededTenant } from "./lib/seed.js";

import type { Client } from "pg";

// ---------------------------------------------------------------------------
// Synthetic release fixtures
// ---------------------------------------------------------------------------

const INGREDIENT_RXCUI = "900001";
const PRECISE_RXCUI = "900002";
const COMPONENT_RXCUI = "910001";
const DRUG_RXCUI = "920001";

/** The manufactured product's NDC, as normalized 11 digits. */
const KNOWN_NDC = "99999000101";
/** In the release but never prescribed here. */
const UNKNOWN_NDC = "99999000999";
/** The org-local compound identifier — in NO release, ever. */
const COMPOUND_NDC = "99999000001";

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

/**
 * Write a synthetic release into a fresh directory. `marker` varies
 * the RXNCONSO content so two versions have different checksums, the
 * way two NLM releases would.
 */
function writeReleaseDir(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pharmax-rxnorm-it-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "RXNCONSO.RRF"),
    [
      consoLine(INGREDIENT_RXCUI, "IN", `FIXTURE-INGREDIENT-${marker}`),
      consoLine(PRECISE_RXCUI, "PIN", `FIXTURE-PRECISE-${marker}`),
      consoLine(COMPONENT_RXCUI, "SCDC", "FIXTURE-COMPONENT"),
      consoLine(DRUG_RXCUI, "SCD", "FIXTURE-DRUG"),
    ].join("\n") + "\n"
  );
  writeFileSync(
    join(dir, "RXNREL.RRF"),
    [
      relLine(DRUG_RXCUI, COMPONENT_RXCUI, "consists_of"),
      relLine(COMPONENT_RXCUI, INGREDIENT_RXCUI, "has_ingredient"),
      relLine(COMPONENT_RXCUI, PRECISE_RXCUI, "has_precise_ingredient"),
    ].join("\n") + "\n"
  );
  writeFileSync(
    join(dir, "RXNSAT.RRF"),
    [satLine(DRUG_RXCUI, KNOWN_NDC), satLine(DRUG_RXCUI, UNKNOWN_NDC)].join("\n") + "\n"
  );
  return dir;
}

async function wipeRxnormTables(): Promise<void> {
  // Global tables: pass through the tenancy extension with no frame.
  // Cascade removes the data rows.
  await prisma.rxnormRelease.deleteMany({});
}

// ---------------------------------------------------------------------------
// Tenant fixtures for the screening path
// ---------------------------------------------------------------------------

const PHI_PLACEHOLDER = JSON.stringify({ v: "placeholder", alg: "test" });

async function insertProvider(client: Client, tenant: SeededTenant): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO provider (
       id, "organizationId", npi, "firstName", "lastName", status, "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, 'Fixture', 'Prescriber', 'ACTIVE', now(), now())`,
    [id, tenant.organizationId, `19999${String(Math.floor(Math.random() * 90000) + 10000)}`]
  );
  return id;
}

async function insertPrescriptionWithLine(
  client: Client,
  tenant: SeededTenant,
  input: { orderId: string; patientId: string; providerId: string; drugNdc: string }
): Promise<string> {
  const prescriptionId = randomUUID();
  await client.query(
    `INSERT INTO prescription (
       id, "organizationId", "clinicId", "patientId", "providerId",
       "rxNumber", "rxNumberBi", "drugNdc", "drugName",
       "quantityAuthorized", "daysSupply", "refillsAuthorized", "refillsRemaining",
       "originalDateWritten", "expiresAt", "sigEnc", status, "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, 'FIXTURE-DRUG-NAME',
       1, 30, 0, 0,
       now(), now() + interval '1 year', $9::jsonb, 'ACTIVE', now(), now()
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

async function insertConfirmedIngredientAllergy(
  client: Client,
  tenant: SeededTenant,
  patientId: string,
  substanceCode: string
): Promise<void> {
  await client.query(
    `INSERT INTO patient_allergy (
       id, "organizationId", "clinicId", "patientId",
       "substanceCode", "substanceCodeSystem",
       category, type, criticality, "clinicalStatus", "verificationStatus",
       "reactionManifestations", "recordedByUserId", "recordedAt", "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, $3, $4,
       $5, 'RXNORM',
       'MEDICATION', 'ALLERGY', 'HIGH', 'ACTIVE', 'CONFIRMED',
       ARRAY[]::"AllergyReactionManifestation"[], $6, now(), now(), now()
     )`,
    [
      randomUUID(),
      tenant.organizationId,
      tenant.clinicId,
      patientId,
      substanceCode,
      tenant.adminUserId,
    ]
  );
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

async function insertCompoundProduct(client: Client, tenant: SeededTenant): Promise<void> {
  await client.query(
    `INSERT INTO product (
       id, "organizationId", ndc, name, "ndcKind", "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, 'FIXTURE-COMPOUND (IT)', 'IN_HOUSE_COMPOUND'::"ProductNdcKind", now(), now())`,
    [randomUUID(), tenant.organizationId, COMPOUND_NDC]
  );
}

// ---------------------------------------------------------------------------

let owner: Client;
let tenant: SeededTenant;

beforeAll(async () => {
  owner = await connect("owner");
  await assertSchemaReady();
  await wipeRxnormTables();
  tenant = await seedTenant(owner);
});

afterAll(async () => {
  await wipeRxnormTables();
  // Rows this suite creates beyond the shared seeder's surface, in
  // leaf-first FK order (provider is referenced by prescription,
  // which is referenced by order_line). `cleanupTenant` re-deletes
  // the first two harmlessly.
  for (const table of ["order_line", "prescription", "product", "provider"]) {
    await owner.query(`DELETE FROM "${table}" WHERE "organizationId" = $1`, [
      tenant.organizationId,
    ]);
  }
  await cleanupTenant(owner, tenant.organizationId);
  await owner.end();
  await prisma.$disconnect().catch(() => undefined);
  resetClinicalScreeningConfigurationForTests();
});

describe("rxnorm ingestion — versioned, checksummed, atomic", () => {
  const v1Dir = writeReleaseDir("V1");

  it("loads a release, promotes it LIVE, and records sane counts", async () => {
    const summary = await ingestRxnormRelease({
      db: prisma,
      directory: v1Dir,
      version: "07072026",
    });
    expect(summary.action).toBe("LOADED");
    expect(summary.ndcCount).toBe(2);
    expect(summary.ingredientLinkCount).toBe(2); // IN + PIN

    const live = await prisma.rxnormRelease.findFirst({ where: { status: "LIVE" } });
    if (live === null) throw new Error("expected a LIVE release after ingestion");
    expect(live.version).toBe("07072026");
    expect(live.ndcCount).toBe(2);
    const rows = await prisma.rxnormNdcProduct.count({ where: { releaseId: live.id } });
    expect(rows).toBe(2);
  });

  it("is idempotent over byte-identical input", async () => {
    const summary = await ingestRxnormRelease({
      db: prisma,
      directory: v1Dir,
      version: "07072026",
    });
    expect(summary.action).toBe("ALREADY_LIVE");
    expect(await prisma.rxnormRelease.count()).toBe(1);
  });

  it("refuses a release older than what is live", async () => {
    const olderDir = writeReleaseDir("V0-OLDER");
    await expect(
      ingestRxnormRelease({ db: prisma, directory: olderDir, version: "06092026" })
    ).rejects.toMatchObject({ code: RXNORM_INGEST_ERRORS.RELEASE_NOT_NEWER });
    // And nothing changed: the live release is still v1.
    const live = await prisma.rxnormRelease.findFirst({ where: { status: "LIVE" } });
    expect(live?.version).toBe("07072026");
  });

  it("refuses a garbage version token before touching anything", async () => {
    await expect(
      ingestRxnormRelease({ db: prisma, directory: v1Dir, version: "13372026" })
    ).rejects.toBeInstanceOf(RxnormIngestError);
  });

  it("supersedes atomically on a newer release, keeping at most one LIVE", async () => {
    const v2Dir = writeReleaseDir("V2");
    const summary = await ingestRxnormRelease({
      db: prisma,
      directory: v2Dir,
      version: "08032026",
    });
    expect(summary.action).toBe("LOADED");

    const releases = await prisma.rxnormRelease.findMany({ orderBy: { releasedOn: "asc" } });
    expect(releases.map((r) => [r.version, r.status])).toEqual([
      ["07072026", "SUPERSEDED"],
      ["08032026", "LIVE"],
    ]);
    // The one-LIVE invariant is also a DATABASE constraint: forcing a
    // second LIVE row must fail on the partial unique index no matter
    // what application code does.
    const superseded = releases.find((r) => r.status === "SUPERSEDED");
    await expect(
      prisma.rxnormRelease.update({
        where: { id: superseded?.id ?? "" },
        data: { status: "LIVE" },
      })
    ).rejects.toThrowError();
  });
});

describe("rxnorm adapter — per-screen prefetch against Postgres", () => {
  it("answers the mapping chain, the missing code, and the release identity", async () => {
    await insertCompoundProduct(owner, tenant);

    const source = await readInOrgScope(tenant.organizationId, (tx) =>
      loadRxnormKnowledgeSourceForScreen({
        tx,
        organizationId: tenant.organizationId,
        drugCodes: [KNOWN_NDC, COMPOUND_NDC, "99999008888"],
      })
    );

    expect(source.coverage).toBe("PROVISIONED");
    expect(source.release).toEqual({
      source: RXNORM_KNOWLEDGE_SOURCE_CODE,
      version: "08032026",
    });
    // The manufactured product resolves to its IN + PIN ingredients.
    expect(source.describeDrug(KNOWN_NDC)?.ingredientCodes).toEqual([
      INGREDIENT_RXCUI,
      PRECISE_RXCUI,
    ]);
    // A code the release does not hold answers null (an honest gap)…
    expect(source.describeDrug("99999008888")).toBeNull();
    expect(source.drugCodeScope("99999008888")).toBe("IN_NOMENCLATURE");
    // …and the org's compound identifier is declared out of scope.
    expect(source.describeDrug(COMPOUND_NDC)).toBeNull();
    expect(source.drugCodeScope(COMPOUND_NDC)).toBe("OUT_OF_NOMENCLATURE");
    // No clinical knowledge, ever, from this source.
    expect(source.findIngredientInteraction(INGREDIENT_RXCUI, PRECISE_RXCUI)).toBeNull();
    expect(source.describeAllergen(INGREDIENT_RXCUI)).toBeNull();
  });
});

describe("end to end — a seeded ingredient allergy hard-stops through the real adapter", () => {
  beforeAll(() => {
    // The production wiring, verbatim (see apps/web bootstrap): a
    // per-screen resolver over the live release.
    configureClinicalScreening({
      knowledgeSourceResolver: (context) =>
        loadRxnormKnowledgeSourceForScreen({
          tx: context.tx,
          organizationId: context.organizationId,
          drugCodes: context.drugCodes,
        }),
    });
  });

  it("BLOCKS the approval gate on a confirmed allergy to the dispensed ingredient", async () => {
    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: KNOWN_NDC,
    });
    // The patient's coded allergy IS the ingredient the release says
    // this NDC contains: RXNORM system, confirmed, high criticality —
    // the one situation the engine refuses outright.
    await insertConfirmedIngredientAllergy(owner, tenant, chain.patientId, INGREDIENT_RXCUI);

    const { screen, refusal } = await readInOrgScope(tenant.organizationId, async (scoped) => {
      // `TenantTransactionClient` deliberately omits the lifecycle
      // members (`$transaction` among them); the screening read path
      // never calls them, so the narrower client is safe where
      // `Prisma.TransactionClient` is asked for.
      const tx = scoped as unknown as Prisma.TransactionClient;
      const result = await runOrderScreen({
        tx,
        organizationId: tenant.organizationId,
        orderId: chain.orderId,
        patientId: chain.patientId,
        policy: { minimumReportedSeverity: "MINOR" },
      });
      const gate = await screeningRefusalForApproval({
        tx,
        organizationId: tenant.organizationId,
        orderId: chain.orderId,
        pharmacistUserId: tenant.adminUserId,
        evaluation: result.evaluation,
      });
      return { screen: result, refusal: gate };
    });

    expect(screen.evaluation.outcome).toBe("BLOCKED");
    const blocking = hardStopFindings(screen.evaluation);
    expect(blocking.map((f) => f.code)).toEqual(["SCR_DRUG_ALLERGY_DIRECT"]);
    expect(blocking[0]).toMatchObject({ severity: "CONTRAINDICATED", certainty: "DEFINITE" });

    // The gate ApprovePV1 runs refuses with the unoverridable code.
    expect(refusal).toMatchObject({ code: "PV1_SCREENING_HARD_STOP" });

    // And the screen knows which body of knowledge produced it.
    expect(screen.knowledgeRelease).toEqual({
      source: RXNORM_KNOWLEDGE_SOURCE_CODE,
      version: "08032026",
    });
  });

  it("records a compound order as honestly unscreened — informational, never a per-order prompt", async () => {
    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: COMPOUND_NDC,
    });
    // History taken and empty, so the only findings can be knowledge
    // and platform gaps.
    await insertNoKnownAllergiesAssertion(owner, tenant, chain.patientId);

    const { screen, refusal } = await readInOrgScope(tenant.organizationId, async (scoped) => {
      // `TenantTransactionClient` deliberately omits the lifecycle
      // members (`$transaction` among them); the screening read path
      // never calls them, so the narrower client is safe where
      // `Prisma.TransactionClient` is asked for.
      const tx = scoped as unknown as Prisma.TransactionClient;
      const result = await runOrderScreen({
        tx,
        organizationId: tenant.organizationId,
        orderId: chain.orderId,
        patientId: chain.patientId,
        policy: { minimumReportedSeverity: "MINOR" },
      });
      const gate = await screeningRefusalForApproval({
        tx,
        organizationId: tenant.organizationId,
        orderId: chain.orderId,
        pharmacistUserId: tenant.adminUserId,
        evaluation: result.evaluation,
      });
      return { screen: result, refusal: gate };
    });

    // The gap is on the record — an unscreened compound must never
    // read as screened-and-clear…
    const compoundGap = screen.evaluation.findings.find(
      (f) => f.code === "SCR_KNOWLEDGE_NOT_APPLICABLE"
    );
    expect(compoundGap).toMatchObject({
      kind: "SCREENING_GAP",
      severity: "MINOR",
      disposition: "INFORMATIONAL",
    });
    // …and it is NOT the acknowledge-tier "verify the NDC" prompt,
    // so the gate passes: a compounding pharmacy is not taxed one
    // acknowledgement per order forever for dispensing compounds.
    expect(
      screen.evaluation.findings.filter((f) => f.code === "SCR_KNOWLEDGE_UNAVAILABLE")
    ).toEqual([]);
    expect(refusal).toBeNull();
  });
});
