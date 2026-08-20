// Compound-preparation allergy screening, proven against real
// Postgres: a fully-coded formula hard-stopping the PV1 gate through
// the REAL composite adapter, the partially-coded case screening its
// coded subset while reporting the remainder, formula-VERSION
// attribution surviving a republish, database-level enforcement of the
// one-ACTIVE-formula-per-product and coded⇔code invariants, and
// tenancy isolation of the formula link (one org's recipe answers
// nothing for another org's identical code string).
//
// NOTE WHAT IS ABSENT: no RxNorm release is ingested anywhere in this
// file. That is the point being proven — a compound's coded
// ingredients answer from the org's own formulary by string equality
// against the patient's coded allergies, with or without a licensed
// national dataset.
//
// FIXTURES ARE SYNTHETIC by clean-room rule: fake RXCUIs (9xxxxx),
// fake org-local compound identifiers, no real drug or ingredient
// name anywhere in this file.
//
// Requires a running Postgres with migrations applied:
//   pnpm db:up && pnpm db:migrate:deploy && pnpm test:integration

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hardStopFindings } from "@pharmax/clinical-screening";
import { prisma, readInOrgScope, type Prisma } from "@pharmax/database";
import { loadDrugKnowledgeSourceForScreen } from "@pharmax/drug-knowledge";
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

/** RxNorm ingredient (IN) RXCUIs — fake 9xxxxx space. */
const ALLERGEN_RXCUI = "900101";
const OTHER_RXCUI = "900102";

/** Org-local compound identifiers. In no national nomenclature. */
const CODED_COMPOUND_NDC = "99999100001";
const PARTIAL_COMPOUND_NDC = "99999100002";
const UNCODED_COMPOUND_NDC = "99999100003";

const PHI_PLACEHOLDER = JSON.stringify({ v: "placeholder", alg: "test" });

async function insertCompoundProduct(
  client: Client,
  organizationId: string,
  ndc: string,
  ndcKind: "IN_HOUSE_COMPOUND" | "NATIONAL" = "IN_HOUSE_COMPOUND"
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO product (
       id, "organizationId", ndc, name, "ndcKind", "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, 'FIXTURE-COMPOUND (IT)', $4::"ProductNdcKind", now(), now())`,
    [id, organizationId, ndc, ndcKind]
  );
  return id;
}

interface FormulaIngredientFixture {
  readonly name: string;
  readonly coding: "UNCODED" | "RXNORM_IN" | "NO_RXNORM_INGREDIENT";
  readonly rxcui?: string;
}

async function insertActiveFormula(
  client: Client,
  tenant: SeededTenant,
  input: {
    readonly code: string;
    readonly version: number;
    readonly compoundProductId: string | null;
    readonly status?: "ACTIVE" | "RETIRED";
    readonly ingredients: ReadonlyArray<FormulaIngredientFixture>;
  }
): Promise<string> {
  const formulaId = randomUUID();
  await client.query(
    `INSERT INTO compound_formula (
       id, "organizationId", code, version, status, name, "preparationKind",
       "budDays", "budBasis", "storageCondition", instructions,
       "compoundProductId", "createdByUserId", "publishedAt", "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, $3, $4, $5::"CompoundFormulaStatus", 'FIXTURE FORMULA', 'NONSTERILE',
       14, 'USP795_AQUEOUS_NONPRESERVED', 'ROOM_TEMPERATURE', 'mix (fixture)',
       $6, $7, now(), now(), now()
     )`,
    [
      formulaId,
      tenant.organizationId,
      input.code,
      input.version,
      input.status ?? "ACTIVE",
      input.compoundProductId,
      tenant.adminUserId,
    ]
  );
  for (const [index, ingredient] of input.ingredients.entries()) {
    await client.query(
      `INSERT INTO compound_formula_ingredient (
         id, "organizationId", "formulaId", "ingredientName", quantity, unit,
         "sortOrder", coding, "rxnormInRxcui", "createdAt"
       ) VALUES ($1, $2, $3, $4, 1, 'g', $5, $6::"CompoundIngredientCoding", $7, now())`,
      [
        randomUUID(),
        tenant.organizationId,
        formulaId,
        ingredient.name,
        index,
        ingredient.coding,
        ingredient.rxcui ?? null,
      ]
    );
  }
  return formulaId;
}

async function insertProvider(client: Client, tenant: SeededTenant): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO provider (
       id, "organizationId", npi, "firstName", "lastName", status, "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, 'Fixture', 'Prescriber', 'ACTIVE', now(), now())`,
    [id, tenant.organizationId, `18888${String(Math.floor(Math.random() * 90000) + 10000)}`]
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

/** Screen + gate for one order, through the production composite. */
async function screenAndGate(tenant: SeededTenant, orderId: string, patientId: string) {
  return readInOrgScope(tenant.organizationId, async (scoped) => {
    // `TenantTransactionClient` deliberately omits the lifecycle
    // members; the screening read path never calls them.
    const tx = scoped as unknown as Prisma.TransactionClient;
    const screen = await runOrderScreen({
      tx,
      organizationId: tenant.organizationId,
      orderId,
      patientId,
      policy: { minimumReportedSeverity: "MINOR" },
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
let otherTenant: SeededTenant;

beforeAll(async () => {
  owner = await connect("owner");
  await assertSchemaReady();
  tenant = await seedTenant(owner);
  otherTenant = await seedTenant(owner);

  // Several assertions below depend on NO RxNorm release existing
  // ("the stamped release identity is honestly null"), so enforce that
  // precondition instead of assuming it: a crashed run of the rxnorm
  // suites can leave a LIVE release behind, and file ordering does not
  // guarantee their cleanup runs before this file.
  await systemDb().rxnormRelease.deleteMany({});

  // The production wiring, verbatim (see apps/web bootstrap): the
  // composite source over RxNorm (no release loaded here — that is
  // the point) and the org's coded formulas.
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
  for (const t of [tenant, otherTenant]) {
    // Leaf-first FK order for rows this suite creates beyond the
    // shared seeder's surface.
    for (const table of [
      "order_line",
      "prescription",
      "compound_formula_ingredient",
      "compound_formula",
      "product",
      "provider",
    ]) {
      await owner.query(`DELETE FROM "${table}" WHERE "organizationId" = $1`, [t.organizationId]);
    }
    await cleanupTenant(owner, t.organizationId);
  }
  await owner.end();
  await disconnectSystemDb();
  await prisma.$disconnect().catch(() => undefined);
  resetClinicalScreeningConfigurationForTests();
});

describe("fully-coded compound — the hard-stop path", () => {
  it("BLOCKS the PV1 gate on a confirmed allergy to a coded formula ingredient, with the formula version stamped", async () => {
    const productId = await insertCompoundProduct(owner, tenant.organizationId, CODED_COMPOUND_NDC);
    const formulaId = await insertActiveFormula(owner, tenant, {
      code: "IT-CODED",
      version: 1,
      compoundProductId: productId,
      ingredients: [
        { name: "FIXTURE-ACTIVE-A", coding: "RXNORM_IN", rxcui: ALLERGEN_RXCUI },
        { name: "FIXTURE-ACTIVE-B", coding: "RXNORM_IN", rxcui: OTHER_RXCUI },
        { name: "FIXTURE-BASE", coding: "NO_RXNORM_INGREDIENT" },
      ],
    });

    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: CODED_COMPOUND_NDC,
    });
    await insertConfirmedIngredientAllergy(owner, tenant, chain.patientId, ALLERGEN_RXCUI);

    const { screen, refusal } = await screenAndGate(tenant, chain.orderId, chain.patientId);

    // The bar this feature exists to reach: same unoverridable refusal
    // a national product's confirmed ingredient allergy produces.
    expect(screen.evaluation.outcome).toBe("BLOCKED");
    const blocking = hardStopFindings(screen.evaluation);
    expect(blocking.map((f) => f.code)).toEqual(["SCR_DRUG_ALLERGY_DIRECT"]);
    expect(blocking[0]).toMatchObject({ severity: "CONTRAINDICATED", certainty: "DEFINITE" });
    expect(refusal).toMatchObject({ code: "PV1_SCREENING_HARD_STOP" });

    // No partial-coding report: every row is coded or accounted for
    // (the asserted base is a made claim, not a gap).
    expect(
      screen.evaluation.findings.filter(
        (f) =>
          f.code === "SCR_COMPOUND_INGREDIENTS_PARTIALLY_CODED" ||
          f.code === "SCR_COMPOUND_FORMULA_NOT_CODED"
      )
    ).toEqual([]);

    // Formula-version attribution rides the finding.
    const hardStop = blocking[0];
    if (hardStop === undefined) throw new Error("unreachable: asserted above");
    expect(screen.formulaProvenanceByFingerprint.get(hardStop.fingerprint)).toEqual({
      formulaId,
      formulaCode: "IT-CODED",
      formulaVersion: 1,
    });

    // And note: no RxNorm release exists in this database. The stampable
    // release identity is honestly null while the formula answer is real.
    expect(screen.knowledgeRelease).toBeNull();
  });

  it("screens CLEAR-of-allergy-findings for a patient with an asserted-empty history", async () => {
    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: CODED_COMPOUND_NDC,
    });
    await insertNoKnownAllergiesAssertion(owner, tenant, chain.patientId);

    const { screen, refusal } = await screenAndGate(tenant, chain.orderId, chain.patientId);

    expect(screen.evaluation.findings.filter((f) => f.code.startsWith("SCR_DRUG_ALLERGY"))).toEqual(
      []
    );
    expect(screen.evaluation.findings.filter((f) => f.code.startsWith("SCR_COMPOUND"))).toEqual([]);
    expect(refusal).toBeNull();
  });
});

describe("partially-coded compound — subset screened, remainder reported", () => {
  it("fires the real finding from the coded row AND the informational partial-coding report", async () => {
    const productId = await insertCompoundProduct(
      owner,
      tenant.organizationId,
      PARTIAL_COMPOUND_NDC
    );
    await insertActiveFormula(owner, tenant, {
      code: "IT-PARTIAL",
      version: 1,
      compoundProductId: productId,
      ingredients: [
        { name: "FIXTURE-ACTIVE-A", coding: "RXNORM_IN", rxcui: ALLERGEN_RXCUI },
        { name: "FIXTURE-MYSTERY-1", coding: "UNCODED" },
        { name: "FIXTURE-MYSTERY-2", coding: "UNCODED" },
      ],
    });

    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: PARTIAL_COMPOUND_NDC,
    });
    await insertConfirmedIngredientAllergy(owner, tenant, chain.patientId, ALLERGEN_RXCUI);

    const { screen, refusal } = await screenAndGate(tenant, chain.orderId, chain.patientId);

    // The coded subset is genuinely screened — the confirmed allergy
    // to the coded row still blocks…
    expect(screen.evaluation.outcome).toBe("BLOCKED");
    expect(refusal).toMatchObject({ code: "PV1_SCREENING_HARD_STOP" });

    // …and the two uncoded rows are reported, informationally: the
    // gap is org-closable (code the formula), so it does not charge
    // the pharmacist an acknowledgement per order.
    const partial = screen.evaluation.findings.find(
      (f) => f.code === "SCR_COMPOUND_INGREDIENTS_PARTIALLY_CODED"
    );
    expect(partial).toMatchObject({
      kind: "SCREENING_GAP",
      severity: "MINOR",
      disposition: "INFORMATIONAL",
    });
    expect(partial?.reason).toContain("2 declared ingredient row(s)");
  });

  it("records an uncoded compound as SCR_COMPOUND_FORMULA_NOT_CODED without gating approval", async () => {
    const productId = await insertCompoundProduct(
      owner,
      tenant.organizationId,
      UNCODED_COMPOUND_NDC
    );
    const formulaId = await insertActiveFormula(owner, tenant, {
      code: "IT-UNCODED",
      version: 1,
      compoundProductId: productId,
      ingredients: [{ name: "FIXTURE-MYSTERY", coding: "UNCODED" }],
    });

    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: UNCODED_COMPOUND_NDC,
    });
    await insertNoKnownAllergiesAssertion(owner, tenant, chain.patientId);

    const { screen, refusal } = await screenAndGate(tenant, chain.orderId, chain.patientId);

    const gap = screen.evaluation.findings.find((f) => f.code === "SCR_COMPOUND_FORMULA_NOT_CODED");
    expect(gap).toMatchObject({
      kind: "SCREENING_GAP",
      severity: "MINOR",
      disposition: "INFORMATIONAL",
    });
    // The superseded spelling must NOT fire: the platform now supports
    // closing this, and SCR_KNOWLEDGE_NOT_APPLICABLE would say it does not.
    expect(
      screen.evaluation.findings.filter((f) => f.code === "SCR_KNOWLEDGE_NOT_APPLICABLE")
    ).toEqual([]);
    expect(refusal).toBeNull();

    // The CONSULTED formula is attributed even though it answered
    // nothing — "which uncoded recipe was on file?" is the question
    // this row's reader asks.
    expect(screen.formulaProvenanceByFingerprint.get(gap?.fingerprint ?? "")).toMatchObject({
      formulaId,
      formulaVersion: 1,
    });
  });
});

describe("formula versioning — attribution follows the republish", () => {
  it("screens against the ACTIVE version and stamps the version in effect at screening time", async () => {
    const ndc = "99999100004";
    const productId = await insertCompoundProduct(owner, tenant.organizationId, ndc);
    // v1: retired. v2: active, differently coded.
    await insertActiveFormula(owner, tenant, {
      code: "IT-VERSIONED",
      version: 1,
      compoundProductId: productId,
      status: "RETIRED",
      ingredients: [{ name: "FIXTURE-ACTIVE-A", coding: "RXNORM_IN", rxcui: OTHER_RXCUI }],
    });
    const v2Id = await insertActiveFormula(owner, tenant, {
      code: "IT-VERSIONED",
      version: 2,
      compoundProductId: productId,
      ingredients: [{ name: "FIXTURE-ACTIVE-A", coding: "RXNORM_IN", rxcui: ALLERGEN_RXCUI }],
    });

    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: ndc,
    });
    await insertConfirmedIngredientAllergy(owner, tenant, chain.patientId, ALLERGEN_RXCUI);

    const { screen } = await screenAndGate(tenant, chain.orderId, chain.patientId);

    // v2's coding is what screens: the allergy matches v2's RXCUI,
    // which v1 never declared.
    expect(screen.evaluation.outcome).toBe("BLOCKED");
    const hardStop = hardStopFindings(screen.evaluation)[0];
    if (hardStop === undefined) throw new Error("expected a hard stop");
    expect(screen.formulaProvenanceByFingerprint.get(hardStop.fingerprint)).toEqual({
      formulaId: v2Id,
      formulaCode: "IT-VERSIONED",
      formulaVersion: 2,
    });
  });

  it("the database refuses a second ACTIVE formula claiming the same product", async () => {
    const productId = await insertCompoundProduct(owner, tenant.organizationId, "99999100005");
    await insertActiveFormula(owner, tenant, {
      code: "IT-CLAIM-A",
      version: 1,
      compoundProductId: productId,
      ingredients: [{ name: "FIXTURE-ACTIVE-A", coding: "RXNORM_IN", rxcui: OTHER_RXCUI }],
    });
    await expect(
      insertActiveFormula(owner, tenant, {
        code: "IT-CLAIM-B",
        version: 1,
        compoundProductId: productId,
        ingredients: [{ name: "FIXTURE-ACTIVE-A", coding: "RXNORM_IN", rxcui: OTHER_RXCUI }],
      })
    ).rejects.toThrowError(/compound_formula_active_product_unique/);
  });

  it("the database refuses a row that claims RXNORM_IN without a code, or a code it disclaims", async () => {
    const formulaId = await insertActiveFormula(owner, tenant, {
      code: "IT-CHECKED",
      version: 1,
      compoundProductId: null,
      ingredients: [{ name: "FIXTURE-ACTIVE-A", coding: "RXNORM_IN", rxcui: OTHER_RXCUI }],
    });
    const badRow = (coding: string, rxcui: string | null) =>
      owner.query(
        `INSERT INTO compound_formula_ingredient (
           id, "organizationId", "formulaId", "ingredientName", quantity, unit,
           "sortOrder", coding, "rxnormInRxcui", "createdAt"
         ) VALUES ($1, $2, $3, 'FIXTURE-BAD', 1, 'g', 99, $4::"CompoundIngredientCoding", $5, now())`,
        [randomUUID(), tenant.organizationId, formulaId, coding, rxcui]
      );
    await expect(badRow("RXNORM_IN", null)).rejects.toThrowError(/coding_rxcui_check/);
    await expect(badRow("UNCODED", OTHER_RXCUI)).rejects.toThrowError(/coding_rxcui_check/);
  });
});

describe("NATIONAL shadowing — the second layer, behind the command refusal", () => {
  it("never consults a formula claiming a NATIONAL product, even when one is in the table", async () => {
    // CreateCompoundFormula refuses this link
    // (COMPOUND_FORMULA_PRODUCT_NOT_COMPOUND), so force the bad state
    // in with raw SQL: a coded ACTIVE formula claiming a NATIONAL
    // product, whose coded ingredient matches the patient's confirmed
    // allergy. If the composite source ever routed a NATIONAL code to
    // the formulary, this screen would hard-stop from an org-authored
    // ingredient list — replacing the published-nomenclature screen a
    // real NDC must get. The routing filter (`ndcKind =
    // IN_HOUSE_COMPOUND` in the compound adapter's product lookup) is
    // what this test pins; dropping it fails here.
    const ndc = "99999100006";
    const productId = await insertCompoundProduct(owner, tenant.organizationId, ndc, "NATIONAL");
    await insertActiveFormula(owner, tenant, {
      code: "IT-SHADOW",
      version: 1,
      compoundProductId: productId,
      ingredients: [{ name: "FIXTURE-ACTIVE-A", coding: "RXNORM_IN", rxcui: ALLERGEN_RXCUI }],
    });

    const chain = await seedOrderChain(owner, tenant);
    const providerId = await insertProvider(owner, tenant);
    await insertPrescriptionWithLine(owner, tenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: ndc,
    });
    await insertConfirmedIngredientAllergy(owner, tenant, chain.patientId, ALLERGEN_RXCUI);

    const { screen, refusal } = await screenAndGate(tenant, chain.orderId, chain.patientId);

    // The org-authored list answered NOTHING for the national code: no
    // allergy findings, no hard stop, no formula provenance — and no
    // org-closable compound gap either, because the code is not the
    // org's to declare. (With no RxNorm release in this database, the
    // honest outcome is the national path's knowledge gap.)
    expect(screen.evaluation.findings.filter((f) => f.code.startsWith("SCR_DRUG_ALLERGY"))).toEqual(
      []
    );
    expect(hardStopFindings(screen.evaluation)).toEqual([]);
    expect(screen.formulaProvenanceByFingerprint.size).toBe(0);
    expect(
      screen.evaluation.findings.filter((f) => f.code === "SCR_COMPOUND_FORMULA_NOT_CODED")
    ).toEqual([]);
    expect(refusal).toBeNull();
  });
});

describe("tenancy isolation — a formula is one org's knowledge only", () => {
  it("does not let org B's identical code string resolve org A's formula", async () => {
    // Org A: coded formula for the shared code string (created in the
    // hard-stop test above). Org B: the same code string flagged
    // compound in ITS catalog, with no formula of its own.
    await insertCompoundProduct(owner, otherTenant.organizationId, CODED_COMPOUND_NDC);

    const chain = await seedOrderChain(owner, otherTenant);
    const providerId = await insertProvider(owner, otherTenant);
    await insertPrescriptionWithLine(owner, otherTenant, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
      drugNdc: CODED_COMPOUND_NDC,
    });
    // Org B's patient is allergic to the very ingredient org A's
    // formula declares — the leak this test exists to rule out would
    // fire a finding from another tenant's recipe.
    await insertConfirmedIngredientAllergy(owner, otherTenant, chain.patientId, ALLERGEN_RXCUI);

    const { screen, refusal } = await screenAndGate(otherTenant, chain.orderId, chain.patientId);

    // No allergy finding: org B has no formula, so there is nothing to
    // compare — and the record says so, org-closably.
    expect(screen.evaluation.findings.filter((f) => f.code.startsWith("SCR_DRUG_ALLERGY"))).toEqual(
      []
    );
    const gap = screen.evaluation.findings.find((f) => f.code === "SCR_COMPOUND_FORMULA_NOT_CODED");
    expect(gap).toMatchObject({ disposition: "INFORMATIONAL" });
    // And no cross-tenant provenance: org A's formula id must not
    // appear anywhere in org B's screen.
    expect(screen.formulaProvenanceByFingerprint.size).toBe(0);
    expect(refusal).toBeNull();
  });

  it("scopes the formula tables by organization under the tenancy extension", async () => {
    const visible = await readInOrgScope(otherTenant.organizationId, (tx) =>
      tx.compoundFormula.findMany({ select: { id: true } })
    );
    expect(visible).toEqual([]);
  });
});
