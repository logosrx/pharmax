// Patient-scoped screening acknowledgements, proven against real
// Postgres — RLS enforced, CHECK constraints live, and the gate
// reading actual rows.
//
// What can only be proven here:
//
//   1. THE DATABASE'S OWN REFUSAL to hold a patient-scoped
//      acknowledgement of a clinical finding. The TypeScript boundary
//      (branded type + classifier) is pinned in unit tests; the CHECK
//      constraints are the layer a bugged handler cannot reach
//      around, and only SQL can see them.
//   2. THE RE-ARM SEQUENCE against real allergy-command semantics:
//      acknowledge → allergy recorded (gap resolves) → record
//      entered-in-error via a status amendment that leaves the row in
//      place → the gap re-arises with the SAME fingerprint → the gate
//      refuses despite the stored acknowledgement, because the
//      record-state token no longer matches.
//   3. APPEND-ONLY posture (missing UPDATE/DELETE grants) and tenant
//      isolation, behaviourally: tenant B's identical fingerprint
//      must not be opened by tenant A's acknowledgement, and an
//      app-role connection in tenant B's context must read zero of
//      tenant A's rows.
//
// CLEAN ROOM / PHI: every code is synthetic (fake 99999… NDC space,
// TEST-INGREDIENT codes), and the fixtures carry placeholder PHI
// envelopes only.
//
// Requires a running Postgres with migrations applied:
//   pnpm db:up && pnpm db:migrate:deploy && pnpm test:integration

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInMemoryDrugKnowledgeSource } from "@pharmax/clinical-screening";
import {
  IntakeSourceKind,
  OrderPriority,
  OrderStatus,
  prisma,
  readInOrgScope,
} from "@pharmax/database";
import type { Prisma, TenantTransactionClient } from "@pharmax/database";
import {
  patientRecordStateToken,
  runOrderScreen,
  screeningRefusalForApproval,
} from "@pharmax/verification";

import { connect, assertSchemaReady, setTenantContext, clearContext } from "./lib/db.js";
import { cleanupTenant, seedOrderChain, seedTenant, type SeededTenant } from "./lib/seed.js";

import type { Client } from "pg";

const PG_CHECK_VIOLATION = "23514";
const PG_INSUFFICIENT_PRIVILEGE = "42501";

const CANDIDATE_NDC = "99999300101";
const PHI_PLACEHOLDER = JSON.stringify({ v: "placeholder", alg: "test" });

let owner: Client;
let tenantA: SeededTenant;
let tenantB: SeededTenant;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

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
  input: { orderId: string; patientId: string; providerId: string }
): Promise<string> {
  const prescriptionId = randomUUID();
  await client.query(
    `INSERT INTO prescription (
       id, "organizationId", "clinicId", "patientId", "providerId",
       "rxNumber", "rxNumberBi", "drugNdc", "drugName",
       "quantityAuthorized", "daysSupply", "refillsAuthorized", "refillsRemaining",
       "originalDateWritten", "expiresAt", "sigEnc",
       status, "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, 'FIXTURE-DRUG-NAME',
       30, 30, 0, 0,
       now(), now() + interval '1 year', $9::jsonb,
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
      CANDIDATE_NDC,
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

/** A SECOND order for an EXISTING patient — the refill shape. */
async function insertOrderForPatient(
  client: Client,
  tenant: SeededTenant,
  patientId: string
): Promise<string> {
  const orderId = randomUUID();
  await client.query(
    `INSERT INTO "order" (
       id, "organizationId", "clinicId", "siteId", "patientId",
       "currentStatus", "currentBucketId",
       "workflowPolicyId", "workflowPolicyVersion",
       version, priority, "intakeSourceKind", "receivedAt", "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::"OrderStatus", $7, $8, $9,
       1, $10::"OrderPriority", $11::"IntakeSourceKind", now(), now(), now()
     )`,
    [
      orderId,
      tenant.organizationId,
      tenant.clinicId,
      tenant.siteId,
      patientId,
      OrderStatus.PV1_IN_PROGRESS,
      tenant.bucketId,
      tenant.workflowPolicyId,
      tenant.workflowPolicyVersion,
      OrderPriority.NORMAL,
      IntakeSourceKind.API,
    ]
  );
  return orderId;
}

/** A screenable allergy row. Returns its id for later amendment. */
async function insertScreenableAllergy(
  client: Client,
  tenant: SeededTenant,
  patientId: string
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO patient_allergy (
       id, "organizationId", "clinicId", "patientId",
       "substanceCode", "substanceCodeSystem",
       category, type, criticality, "clinicalStatus", "verificationStatus",
       "reactionManifestations", "recordedByUserId", "recordedAt",
       "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, $3, $4,
       'TEST-INGREDIENT-1', 'RXNORM'::"AllergySubstanceCodeSystem",
       'MEDICATION'::"AllergyCategory", 'ALLERGY'::"AllergyIntoleranceType",
       'LOW'::"AllergyCriticality", 'ACTIVE'::"AllergyClinicalStatus",
       'CONFIRMED'::"AllergyVerificationStatus",
       ARRAY[]::"AllergyReactionManifestation"[], $5, now(),
       now(), now()
     )`,
    [id, tenant.organizationId, tenant.clinicId, patientId, tenant.adminUserId]
  );
  return id;
}

/**
 * Retract an allergy the way `AmendPatientAllergyStatus` does: a
 * fully-stamped status amendment that leaves the row in place. Run as
 * owner for fixture control; the production path is the command.
 */
async function enterAllergyInError(
  client: Client,
  tenant: SeededTenant,
  allergyId: string
): Promise<void> {
  await client.query(
    `UPDATE patient_allergy
        SET "verificationStatus" = 'ENTERED_IN_ERROR'::"AllergyVerificationStatus",
            "statusChangedByUserId" = $2,
            "statusChangedAt" = now(),
            "statusChangeReason" = 'entered-in-error-data-entry',
            "updatedAt" = now()
      WHERE id = $1`,
    [allergyId, tenant.adminUserId]
  );
}

/** Screen + gate for one order, as one pharmacist. */
async function screenAndGate(
  tenant: SeededTenant,
  orderId: string,
  patientId: string,
  pharmacistUserId: string = tenant.adminUserId
) {
  return readInOrgScope(tenant.organizationId, async (scoped) => {
    const tx = scoped as unknown as Prisma.TransactionClient;
    const screen = await runOrderScreen({
      tx,
      organizationId: tenant.organizationId,
      orderId,
      patientId,
      policy: { minimumReportedSeverity: "MINOR" },
      knowledgeSource: createInMemoryDrugKnowledgeSource(),
    });
    const refusal = await screeningRefusalForApproval({
      tx,
      organizationId: tenant.organizationId,
      orderId,
      patientId,
      pharmacistUserId,
      evaluation: screen.evaluation,
    });
    return { screen, refusal };
  });
}

/** The allergy-gap fingerprint the screen just produced. */
function allergyGapFingerprintOf(screen: Awaited<ReturnType<typeof screenAndGate>>["screen"]) {
  const gap = screen.evaluation.findings.find((f) => f.code === "SCR_ALLERGY_INPUT_UNAVAILABLE");
  expect(gap).toBeDefined();
  expect(gap).toMatchObject({ disposition: "REQUIRES_ACKNOWLEDGEMENT" });
  return gap!.fingerprint;
}

/** The current record-state token, by the gate's own computation. */
async function currentToken(tenant: SeededTenant, patientId: string): Promise<string> {
  return readInOrgScope(tenant.organizationId, (scoped) =>
    patientRecordStateToken(
      {
        tx: scoped as unknown as TenantTransactionClient,
        organizationId: tenant.organizationId,
        patientId,
      },
      "DRUG_ALLERGY"
    )
  );
}

interface PatientAckOverrides {
  readonly pharmacistUserId?: string;
  readonly axis?: string;
  readonly findingCode?: string;
  readonly recordStateToken?: string;
}

/** Insert a patient-scoped acknowledgement row (owner fixture write). */
async function insertPatientAck(
  client: Client,
  tenant: SeededTenant,
  input: {
    patientId: string;
    orderId: string;
    commandLogId: string;
    fingerprint: string;
    recordStateToken: string;
  },
  overrides: PatientAckOverrides = {}
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO patient_screening_acknowledgement (
       id, "organizationId", "patientId", "orderId", axis,
       fingerprint, "findingCode", severity, certainty, "recordStateToken",
       "pharmacistUserId", "workflowPolicyId", "workflowPolicyVersion",
       "commandLogId", "acknowledgedAt", "createdAt"
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, 'MODERATE', 'DEFINITE', $8,
       $9, $10, $11,
       $12, now(), now()
     )`,
    [
      id,
      tenant.organizationId,
      input.patientId,
      input.orderId,
      overrides.axis ?? "DRUG_ALLERGY",
      input.fingerprint,
      overrides.findingCode ?? "SCR_ALLERGY_INPUT_UNAVAILABLE",
      overrides.recordStateToken ?? input.recordStateToken,
      overrides.pharmacistUserId ?? tenant.adminUserId,
      tenant.workflowPolicyId,
      tenant.workflowPolicyVersion,
      input.commandLogId,
    ]
  );
  return id;
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  owner = await connect("owner");
  await assertSchemaReady();
  tenantA = await seedTenant(owner);
  tenantB = await seedTenant(owner);
});

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    for (const table of ["order_line", "prescription", "provider"]) {
      await owner.query(`DELETE FROM "${table}" WHERE "organizationId" = $1`, [
        tenant.organizationId,
      ]);
    }
    await cleanupTenant(owner, tenant.organizationId);
  }
  await owner.end();
  await prisma.$disconnect().catch(() => undefined);
});

describe("the gate's scoping split, against real rows", () => {
  it("a patient-scoped acknowledgement admits the SAME pharmacist across the patient's orders — and a colleague nowhere", async () => {
    const chain = await seedOrderChain(owner, tenantA);
    const providerId = await insertProvider(owner, tenantA);
    await insertPrescriptionWithLine(owner, tenantA, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
    });

    // Nobody has taken an allergy history: the gap refuses.
    const first = await screenAndGate(tenantA, chain.orderId, chain.patientId);
    const fingerprint = allergyGapFingerprintOf(first.screen);
    expect(first.refusal).toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });

    // The pharmacist acknowledges — patient-scoped, at the current
    // record state.
    await insertPatientAck(owner, tenantA, {
      patientId: chain.patientId,
      orderId: chain.orderId,
      commandLogId: chain.commandLogId,
      fingerprint,
      recordStateToken: await currentToken(tenantA, chain.patientId),
    });

    // The same order passes…
    expect((await screenAndGate(tenantA, chain.orderId, chain.patientId)).refusal).toBeNull();

    // …and so does a SECOND order for the same patient, with no
    // acknowledgement of any kind recorded on it. This is the refill
    // that used to cost an identical click.
    const secondOrderId = await insertOrderForPatient(owner, tenantA, chain.patientId);
    await insertPrescriptionWithLine(owner, tenantA, {
      orderId: secondOrderId,
      patientId: chain.patientId,
      providerId,
    });
    expect((await screenAndGate(tenantA, secondOrderId, chain.patientId)).refusal).toBeNull();

    // A colleague is still refused on both: the judgement is personal.
    const colleague = randomUUID();
    expect(
      (await screenAndGate(tenantA, secondOrderId, chain.patientId, colleague)).refusal
    ).toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });
  });

  it("RE-ARMS: acknowledge → allergy recorded → entered-in-error → the SAME fingerprint prompts afresh", async () => {
    const chain = await seedOrderChain(owner, tenantA);
    const providerId = await insertProvider(owner, tenantA);
    await insertPrescriptionWithLine(owner, tenantA, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
    });

    // 1. The gap, acknowledged at the empty record state.
    const first = await screenAndGate(tenantA, chain.orderId, chain.patientId);
    const fingerprint = allergyGapFingerprintOf(first.screen);
    await insertPatientAck(owner, tenantA, {
      patientId: chain.patientId,
      orderId: chain.orderId,
      commandLogId: chain.commandLogId,
      fingerprint,
      recordStateToken: await currentToken(tenantA, chain.patientId),
    });
    expect((await screenAndGate(tenantA, chain.orderId, chain.patientId)).refusal).toBeNull();

    // 2. An allergy is recorded: the axis resolves, the gap stops
    //    being emitted, and the acknowledgement is moot.
    const allergyId = await insertScreenableAllergy(owner, tenantA, chain.patientId);
    const resolved = await screenAndGate(tenantA, chain.orderId, chain.patientId);
    expect(resolved.screen.evaluation.findings.map((f) => f.code)).not.toContain(
      "SCR_ALLERGY_INPUT_UNAVAILABLE"
    );
    expect(resolved.refusal).toBeNull();

    // 3. The record is retracted as entered-in-error — a status
    //    amendment; the ROW REMAINS. The gap re-arises with the SAME
    //    fingerprint the pharmacist once acknowledged…
    await enterAllergyInError(owner, tenantA, allergyId);
    const rearmed = await screenAndGate(tenantA, chain.orderId, chain.patientId);
    expect(allergyGapFingerprintOf(rearmed.screen)).toBe(fingerprint);

    //    …and the years-old acknowledgement does NOT swallow it: data
    //    disappearing from a patient record deserves fresh eyes.
    expect(rearmed.refusal).toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });

    // 4. A fresh judgement at the NEW record state is a NEW row (the
    //    token is part of the unique key), and it admits again.
    await insertPatientAck(owner, tenantA, {
      patientId: chain.patientId,
      orderId: chain.orderId,
      commandLogId: chain.commandLogId,
      fingerprint,
      recordStateToken: await currentToken(tenantA, chain.patientId),
    });
    expect((await screenAndGate(tenantA, chain.orderId, chain.patientId)).refusal).toBeNull();
    const rows = await owner.query(
      `SELECT count(*)::int AS n FROM patient_screening_acknowledgement
        WHERE "organizationId" = $1 AND "patientId" = $2 AND fingerprint = $3`,
      [tenantA.organizationId, chain.patientId, fingerprint]
    );
    expect(rows.rows[0]?.n).toBe(2);
  });

  it("BACKWARD COMPAT: a pre-existing order-scoped acknowledgement satisfies its own order and does not travel", async () => {
    const chain = await seedOrderChain(owner, tenantA);
    const providerId = await insertProvider(owner, tenantA);
    await insertPrescriptionWithLine(owner, tenantA, {
      orderId: chain.orderId,
      patientId: chain.patientId,
      providerId,
    });

    const first = await screenAndGate(tenantA, chain.orderId, chain.patientId);
    const fingerprint = allergyGapFingerprintOf(first.screen);

    // The row a pre-patient-scope build wrote: order-scoped, in the
    // ORDER acknowledgement table.
    await owner.query(
      `INSERT INTO order_screening_acknowledgement (
         id, "organizationId", "orderId", fingerprint, "findingCode",
         severity, certainty, "pharmacistUserId",
         "workflowPolicyId", "workflowPolicyVersion", "commandLogId",
         "acknowledgedAt", "createdAt"
       ) VALUES (
         $1, $2, $3, $4, 'SCR_ALLERGY_INPUT_UNAVAILABLE',
         'MODERATE', 'DEFINITE', $5,
         $6, $7, $8, now(), now()
       )`,
      [
        randomUUID(),
        tenantA.organizationId,
        chain.orderId,
        fingerprint,
        tenantA.adminUserId,
        tenantA.workflowPolicyId,
        tenantA.workflowPolicyVersion,
        chain.commandLogId,
      ]
    );

    // Honored on its own order — legacy judgements are not
    // invalidated…
    expect((await screenAndGate(tenantA, chain.orderId, chain.patientId)).refusal).toBeNull();

    // …and confined to it: the next order for the same patient
    // prompts, exactly as the old keying always did.
    const secondOrderId = await insertOrderForPatient(owner, tenantA, chain.patientId);
    await insertPrescriptionWithLine(owner, tenantA, {
      orderId: secondOrderId,
      patientId: chain.patientId,
      providerId,
    });
    expect((await screenAndGate(tenantA, secondOrderId, chain.patientId)).refusal).toMatchObject({
      code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED",
    });
  });

  it("TENANCY: tenant A's acknowledgement opens nothing in tenant B, though the fingerprint is identical", async () => {
    // The allergy-history gap's fingerprint carries no patient and no
    // tenant — it is the same string everywhere — which makes this
    // the sharpest cross-tenant test available: only the org scope on
    // the read separates the two.
    const chainB = await seedOrderChain(owner, tenantB);
    const providerB = await insertProvider(owner, tenantB);
    await insertPrescriptionWithLine(owner, tenantB, {
      orderId: chainB.orderId,
      patientId: chainB.patientId,
      providerId: providerB,
    });

    const chainA = await seedOrderChain(owner, tenantA);
    const providerA = await insertProvider(owner, tenantA);
    await insertPrescriptionWithLine(owner, tenantA, {
      orderId: chainA.orderId,
      patientId: chainA.patientId,
      providerId: providerA,
    });

    const screenB = await screenAndGate(
      tenantB,
      chainB.orderId,
      chainB.patientId,
      tenantB.adminUserId
    );
    const fingerprint = allergyGapFingerprintOf(screenB.screen);

    // Tenant A acknowledges the same fingerprint for its own patient.
    await insertPatientAck(owner, tenantA, {
      patientId: chainA.patientId,
      orderId: chainA.orderId,
      commandLogId: chainA.commandLogId,
      fingerprint,
      recordStateToken: await currentToken(tenantA, chainA.patientId),
    });

    // Tenant B's gate is unmoved.
    expect(
      (await screenAndGate(tenantB, chainB.orderId, chainB.patientId, tenantB.adminUserId)).refusal
    ).toMatchObject({ code: "PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED" });

    // And behaviourally at the RLS layer: an app connection in tenant
    // B's context reads zero of tenant A's rows.
    const app = await connect("app");
    try {
      await setTenantContext(app, tenantB.organizationId);
      const asB = await app.query(
        `SELECT count(*)::int AS n FROM patient_screening_acknowledgement WHERE fingerprint = $1`,
        [fingerprint]
      );
      expect(asB.rows[0]?.n).toBe(0);
      await setTenantContext(app, tenantA.organizationId);
      const asA = await app.query(
        `SELECT count(*)::int AS n FROM patient_screening_acknowledgement WHERE fingerprint = $1`,
        [fingerprint]
      );
      expect(asA.rows[0]?.n).toBeGreaterThan(0);
      await clearContext(app);
    } finally {
      await app.end().catch(() => undefined);
    }
  });
});

describe("patient_screening_acknowledgement — the database's own boundary", () => {
  it("refuses a clinical finding's code: the CHECK constraint is the layer no handler can reach around", async () => {
    const chain = await seedOrderChain(owner, tenantA);
    await expect(
      insertPatientAck(
        owner,
        tenantA,
        {
          patientId: chain.patientId,
          orderId: chain.orderId,
          commandLogId: chain.commandLogId,
          fingerprint: "SCR_DRUG_INTERACTION|MAJOR/PROBABLE|X+Y",
          recordStateToken: "any",
        },
        { findingCode: "SCR_DRUG_INTERACTION" }
      )
    ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
  });

  it("refuses an axis that is not PER_SUBJECT", async () => {
    const chain = await seedOrderChain(owner, tenantA);
    await expect(
      insertPatientAck(
        owner,
        tenantA,
        {
          patientId: chain.patientId,
          orderId: chain.orderId,
          commandLogId: chain.commandLogId,
          fingerprint: "SCR_ALLERGY_INPUT_UNAVAILABLE|MODERATE/DEFINITE|DRUG_ALLERGY",
          recordStateToken: "any",
        },
        { axis: "DOSE_RANGE" }
      )
    ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
  });

  it("is append-only for the application role: no UPDATE, no DELETE", async () => {
    const chain = await seedOrderChain(owner, tenantA);
    const ackId = await insertPatientAck(owner, tenantA, {
      patientId: chain.patientId,
      orderId: chain.orderId,
      commandLogId: chain.commandLogId,
      fingerprint:
        "SCR_ALLERGY_INPUT_UNAVAILABLE|MODERATE/DEFINITE|DRUG_ALLERGY|remediation=SUBJECT_DATA",
      recordStateToken: `tok-${randomUUID()}`,
    });

    const app = await connect("app");
    try {
      await setTenantContext(app, tenantA.organizationId);
      await expect(
        app.query(`UPDATE patient_screening_acknowledgement SET severity = 'MINOR' WHERE id = $1`, [
          ackId,
        ])
      ).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
      await expect(
        app.query(`DELETE FROM patient_screening_acknowledgement WHERE id = $1`, [ackId])
      ).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
    } finally {
      await app.end().catch(() => undefined);
    }
  });

  it("one judgement per (patient, pharmacist, fingerprint, record state): the unique key holds", async () => {
    const chain = await seedOrderChain(owner, tenantA);
    const fingerprint =
      "SCR_ALLERGY_INPUT_UNAVAILABLE|MODERATE/DEFINITE|DRUG_ALLERGY|remediation=SUBJECT_DATA";
    const token = `tok-${randomUUID()}`;
    await insertPatientAck(owner, tenantA, {
      patientId: chain.patientId,
      orderId: chain.orderId,
      commandLogId: chain.commandLogId,
      fingerprint,
      recordStateToken: token,
    });
    // Same key: refused by the index.
    await expect(
      insertPatientAck(owner, tenantA, {
        patientId: chain.patientId,
        orderId: chain.orderId,
        commandLogId: chain.commandLogId,
        fingerprint,
        recordStateToken: token,
      })
    ).rejects.toMatchObject({ code: "23505" });
    // A DIFFERENT record state is a different judgement: accepted.
    await expect(
      insertPatientAck(owner, tenantA, {
        patientId: chain.patientId,
        orderId: chain.orderId,
        commandLogId: chain.commandLogId,
        fingerprint,
        recordStateToken: `tok-${randomUUID()}`,
      })
    ).resolves.toBeTruthy();
  });
});
