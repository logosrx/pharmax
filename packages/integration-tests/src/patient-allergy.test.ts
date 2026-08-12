// Allergy capture, proven against the database rather than the ORM.
//
// Three classes of guarantee live in SQL and nowhere else, so they can
// only be verified here:
//
//   1. The CHECK constraints. A rule enforced only in Zod is a rule the
//      seed script, a backfill, and a future second write path do not
//      obey — and the specific rules here (a coded system must carry a
//      code; an uncoded record must carry a label; a status change must
//      be fully stamped) each exist to stop a row that the screening
//      layer would silently skip.
//
//   2. THE ABSENCE OF A DELETE PATH. "Clinical data is corrected, not
//      deleted" is enforced by a missing grant AND a missing RLS policy.
//      No unit test can see either. This is the file that proves an
//      allergy cannot be erased, which is the whole reason retraction is
//      a status change.
//
//   3. Tenant isolation on the new tables, behaviourally: tenant A's
//      connection must not see tenant B's allergies. The structural half
//      (RLS enabled, FORCEd, policy present) is already exhaustive over
//      `TENANT_SCOPED_MODELS` in `cross-tenant-isolation.test.ts`, which
//      covers these two models the moment they were registered. What is
//      added here is the behavioural read, because an allergy leaking
//      across tenants is not merely a privacy failure — it would screen
//      one patient's prescription against another patient's allergies.
//
// Requires a running Postgres with migrations applied:
//   pnpm db:up && pnpm db:migrate:deploy && pnpm test:integration

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSchemaReady, connect, setTenantContext } from "./lib/db.js";
import { cleanupTenant, seedTenant, type SeededTenant } from "./lib/seed.js";

import type { Client } from "pg";

const PG_CHECK_VIOLATION = "23514";
const PG_INSUFFICIENT_PRIVILEGE = "42501";

let owner: Client;
let tenantA: SeededTenant;
let tenantB: SeededTenant;
let patientA: string;
let patientB: string;

async function insertPatient(client: Client, tenant: SeededTenant): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO patient (
       id, "organizationId", "clinicId", status, "lastNameBi", "firstNameBi", "dobBi",
       "dobYearMonthBi", "createdAt", "updatedAt"
     )
     VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6, $7, now(), now())`,
    [id, tenant.organizationId, tenant.clinicId, `bi-${id}`, `bi-${id}`, `bi-${id}`, `bi-${id}`]
  );
  return id;
}

/** Insert an allergy row. Returns the id; throws the raw pg error. */
async function insertAllergy(
  client: Client,
  tenant: SeededTenant,
  patientId: string,
  overrides: Readonly<Record<string, unknown>> = {}
): Promise<string> {
  const row = {
    substanceCode: "TEST-INGREDIENT-1",
    substanceCodeSystem: "RXNORM",
    substanceLabelEnc: null,
    category: "MEDICATION",
    type: "ALLERGY",
    criticality: "LOW",
    clinicalStatus: "ACTIVE",
    verificationStatus: "CONFIRMED",
    statusChangedByUserId: null,
    statusChangedAt: null,
    statusChangeReason: null,
    ...overrides,
  };
  const id = randomUUID();
  await client.query(
    `INSERT INTO patient_allergy (
       id, "organizationId", "clinicId", "patientId",
       "substanceCode", "substanceCodeSystem", "substanceLabelEnc",
       category, type, criticality, "clinicalStatus", "verificationStatus",
       "reactionManifestations",
       "recordedByUserId", "recordedAt",
       "statusChangedByUserId", "statusChangedAt", "statusChangeReason",
       "createdAt", "updatedAt"
     )
     VALUES (
       $1, $2, $3, $4,
       $5, $6::"AllergySubstanceCodeSystem", $7::jsonb,
       $8::"AllergyCategory", $9::"AllergyIntoleranceType", $10::"AllergyCriticality",
       $11::"AllergyClinicalStatus", $12::"AllergyVerificationStatus",
       ARRAY[]::"AllergyReactionManifestation"[],
       $13, now(),
       $14, $15, $16,
       now(), now()
     )`,
    [
      id,
      tenant.organizationId,
      tenant.clinicId,
      patientId,
      row.substanceCode,
      row.substanceCodeSystem,
      row.substanceLabelEnc === null ? null : JSON.stringify(row.substanceLabelEnc),
      row.category,
      row.type,
      row.criticality,
      row.clinicalStatus,
      row.verificationStatus,
      tenant.adminUserId,
      row.statusChangedByUserId,
      row.statusChangedAt,
      row.statusChangeReason,
    ]
  );
  return id;
}

beforeAll(async () => {
  owner = await connect("owner");
  await assertSchemaReady();
  tenantA = await seedTenant(owner);
  tenantB = await seedTenant(owner);
  patientA = await insertPatient(owner, tenantA);
  patientB = await insertPatient(owner, tenantB);
});

afterAll(async () => {
  await cleanupTenant(owner, tenantA.organizationId);
  await cleanupTenant(owner, tenantB.organizationId);
  await owner.end();
});

describe("patient_allergy — CHECK constraints", () => {
  it("accepts a coded record with a code", async () => {
    await expect(insertAllergy(owner, tenantA, patientA)).resolves.toBeTruthy();
  });

  it("rejects a coded system with NO code", async () => {
    // The row this stops is the dangerous one: the screening layer only
    // treats a record as usable input when it carries a comparable code,
    // so a coded system with a NULL code is a record that looks
    // screenable and is not.
    await expect(
      insertAllergy(owner, tenantA, patientA, { substanceCode: null })
    ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
  });

  it("rejects an UNCODED record that carries a code", async () => {
    await expect(
      insertAllergy(owner, tenantA, patientA, {
        substanceCodeSystem: "UNCODED",
        substanceCode: "SOMETHING",
        substanceLabelEnc: { ct: "x" },
      })
    ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
  });

  it("rejects an UNCODED record with no narrative label", async () => {
    // "The patient has an allergy, we do not know to what, and we did
    // not write down what they said" is worse than no record: it
    // occupies the space where a pharmacist would look for the answer.
    await expect(
      insertAllergy(owner, tenantA, patientA, {
        substanceCodeSystem: "UNCODED",
        substanceCode: null,
        substanceLabelEnc: null,
      })
    ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
  });

  it("accepts an UNCODED record with a label", async () => {
    await expect(
      insertAllergy(owner, tenantA, patientA, {
        substanceCodeSystem: "UNCODED",
        substanceCode: null,
        substanceLabelEnc: { ct: "opaque" },
      })
    ).resolves.toBeTruthy();
  });

  it("rejects a partially stamped status change", async () => {
    // Every status change needs a user, a time AND a reason code. Two of
    // the three is a change nobody can explain later, which is exactly
    // what the workflow rules forbid for a rejection or a hold.
    await expect(
      insertAllergy(owner, tenantA, patientA, {
        verificationStatus: "REFUTED",
        statusChangedByUserId: tenantA.adminUserId,
        statusChangedAt: new Date(),
        statusChangeReason: null,
      })
    ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });

    await expect(
      insertAllergy(owner, tenantA, patientA, {
        verificationStatus: "REFUTED",
        statusChangedByUserId: null,
        statusChangedAt: null,
        statusChangeReason: "refuted-by-allergy-testing",
      })
    ).rejects.toMatchObject({ code: PG_CHECK_VIOLATION });
  });

  it("accepts a fully stamped status change", async () => {
    await expect(
      insertAllergy(owner, tenantA, patientA, {
        verificationStatus: "REFUTED",
        statusChangedByUserId: tenantA.adminUserId,
        statusChangedAt: new Date(),
        statusChangeReason: "refuted-by-allergy-testing",
      })
    ).resolves.toBeTruthy();
  });
});

describe("patient_allergy — corrected, never deleted", () => {
  it("lets the app role UPDATE a status but NOT DELETE the row", async () => {
    // The structural half of "clinical data is corrected, not deleted".
    // No DELETE grant and no RLS policy FOR DELETE, so both layers would
    // have to be re-opened before an allergy could be erased.
    const allergyId = await insertAllergy(owner, tenantA, patientA);
    const app = await connect("app");
    try {
      await setTenantContext(app, tenantA.organizationId);

      // Retraction works.
      const updated = await app.query(
        `UPDATE patient_allergy
            SET "verificationStatus" = 'ENTERED_IN_ERROR',
                "statusChangedByUserId" = $2,
                "statusChangedAt" = now(),
                "statusChangeReason" = 'entered-in-error-wrong-patient',
                "updatedAt" = now()
          WHERE id = $1`,
        [allergyId, tenantA.adminUserId]
      );
      expect(updated.rowCount).toBe(1);

      // Erasure does not.
      await expect(
        app.query(`DELETE FROM patient_allergy WHERE id = $1`, [allergyId])
      ).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });

      // And the row is still there, retracted.
      const still = await app.query(
        `SELECT "verificationStatus", "statusChangeReason" FROM patient_allergy WHERE id = $1`,
        [allergyId]
      );
      expect(still.rows[0]).toMatchObject({
        verificationStatus: "ENTERED_IN_ERROR",
        statusChangeReason: "entered-in-error-wrong-patient",
      });
    } finally {
      await app.end();
    }
  });

  it("denies an in-place recode of content columns", async () => {
    // The UPDATE grant is column-level: status columns and their change
    // stamp only. Content — what the allergy IS — is corrected by
    // retiring the record and recording a new one. This is the
    // structural guard behind patient-scoped screening acknowledgements:
    // recordStateToken hashes the allergy-record neighbourhood, and a
    // recode-in-place that flipped screenability without moving that
    // hash would leave a stale acknowledgement standing over findings
    // the pharmacist never saw. No command does this today; this test
    // is here so one cannot be written without a migration diff.
    const allergyId = await insertAllergy(owner, tenantA, patientA);
    const app = await connect("app");
    try {
      await setTenantContext(app, tenantA.organizationId);

      const recodes: ReadonlyArray<[string, string]> = [
        [`"substanceCode" = 'TEST-INGREDIENT-2'`, "substance"],
        [`"substanceCodeSystem" = 'UNCODED', "substanceCode" = NULL`, "code system"],
        [`category = 'FOOD'`, "category"],
        [`"patientId" = '${patientB}'`, "patient"],
      ];
      for (const [setClause] of recodes) {
        await expect(
          app.query(`UPDATE patient_allergy SET ${setClause} WHERE id = $1`, [allergyId])
        ).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
      }

      // The record is untouched.
      const still = await app.query(
        `SELECT "substanceCode", category::text AS category FROM patient_allergy WHERE id = $1`,
        [allergyId]
      );
      expect(still.rows[0]).toMatchObject({
        substanceCode: "TEST-INGREDIENT-1",
        category: "MEDICATION",
      });
    } finally {
      await app.end();
    }
  });

  it("denies UPDATE and DELETE on a history assertion", async () => {
    // Stronger posture than the allergy table: an assertion is
    // append-only, because a superseded one is the record of who said
    // this patient had no allergies, and when.
    const assertionId = randomUUID();
    await owner.query(
      `INSERT INTO patient_allergy_history_assertion (
         id, "organizationId", "clinicId", "patientId", status,
         "assertedByUserId", "assertedAt", "createdAt"
       )
       VALUES ($1, $2, $3, $4, 'NO_KNOWN_ALLERGIES'::"AllergyHistoryAssertionStatus", $5, now(), now())`,
      [assertionId, tenantA.organizationId, tenantA.clinicId, patientA, tenantA.adminUserId]
    );

    const app = await connect("app");
    try {
      await setTenantContext(app, tenantA.organizationId);
      await expect(
        app.query(
          `UPDATE patient_allergy_history_assertion SET status = 'UNABLE_TO_ASSESS' WHERE id = $1`,
          [assertionId]
        )
      ).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
      await expect(
        app.query(`DELETE FROM patient_allergy_history_assertion WHERE id = $1`, [assertionId])
      ).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
    } finally {
      await app.end();
    }
  });
});

describe("patient_allergy — tenant isolation, behaviourally", () => {
  it("hides another tenant's allergies and assertions from the app role", async () => {
    // Not merely a privacy failure if this leaks: the PV1 screening
    // layer reads these rows, so a cross-tenant read would screen one
    // patient's prescription against a different patient's allergies.
    await insertAllergy(owner, tenantB, patientB);
    const assertionId = randomUUID();
    await owner.query(
      `INSERT INTO patient_allergy_history_assertion (
         id, "organizationId", "clinicId", "patientId", status,
         "assertedByUserId", "assertedAt", "createdAt"
       )
       VALUES ($1, $2, $3, $4, 'NO_KNOWN_ALLERGIES'::"AllergyHistoryAssertionStatus", $5, now(), now())`,
      [assertionId, tenantB.organizationId, tenantB.clinicId, patientB, tenantB.adminUserId]
    );

    const app = await connect("app");
    try {
      await setTenantContext(app, tenantA.organizationId);

      const allergies = await app.query(
        `SELECT count(*)::int AS n FROM patient_allergy WHERE "organizationId" = $1`,
        [tenantB.organizationId]
      );
      expect(allergies.rows[0]?.n).toBe(0);

      const assertions = await app.query(
        `SELECT count(*)::int AS n FROM patient_allergy_history_assertion
          WHERE "organizationId" = $1`,
        [tenantB.organizationId]
      );
      expect(assertions.rows[0]?.n).toBe(0);

      // Tenant A's own rows ARE visible, so the zeroes above mean
      // isolation rather than a broken query.
      const own = await app.query(
        `SELECT count(*)::int AS n FROM patient_allergy WHERE "organizationId" = $1`,
        [tenantA.organizationId]
      );
      expect(own.rows[0]?.n).toBeGreaterThan(0);
    } finally {
      await app.end();
    }
  });

  it("refuses an INSERT that would place a row in another tenant", async () => {
    // The WITH CHECK half of the policy. Without it a tenant could write
    // an allergy into another tenant's patient — which would then be
    // screened as that patient's.
    const app = await connect("app");
    try {
      await setTenantContext(app, tenantA.organizationId);
      await expect(
        app.query(
          `INSERT INTO patient_allergy (
             id, "organizationId", "clinicId", "patientId",
             "substanceCode", "substanceCodeSystem", category, type, criticality,
             "clinicalStatus", "verificationStatus", "reactionManifestations",
             "recordedByUserId", "recordedAt", "createdAt", "updatedAt"
           )
           VALUES (
             $1, $2, $3, $4, 'X', 'RXNORM'::"AllergySubstanceCodeSystem",
             'MEDICATION'::"AllergyCategory", 'ALLERGY'::"AllergyIntoleranceType",
             'LOW'::"AllergyCriticality", 'ACTIVE'::"AllergyClinicalStatus",
             'CONFIRMED'::"AllergyVerificationStatus",
             ARRAY[]::"AllergyReactionManifestation"[],
             $5, now(), now(), now()
           )`,
          [randomUUID(), tenantB.organizationId, tenantB.clinicId, patientB, tenantB.adminUserId]
        )
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }
  });
});
