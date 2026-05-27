// Admin patient search — wraps `@pharmax/patients::searchPatients`
// for the operator console and decrypts the identity fields each
// row needs to disambiguate (firstName, lastName, dateOfBirth,
// mrn). Phone / email / address are NOT decrypted on the search
// page — that's a deeper PHI surface reserved for the detail
// page.
//
// Why decrypt at all in search: the threat model for
// `searchPatients` calls out "two patients can share a hash for
// the same name and still differ on DOB; trusting the hash alone
// is a security bug." The operator needs name + DOB to confirm
// match identity before clicking through; without it, they could
// click the wrong patient and update the wrong record.
//
// Bounding: search refuses to run with an empty query (enforced
// inside `searchPatients`). Default page size is 25; we clamp to
// 50 here to keep the per-render decrypt cost predictable
// (50 rows × 4 envelopes = 200 decrypt calls per page).
//
// Result rows are returned with the encrypted envelope columns
// STRIPPED — the page never has access to encrypted material on
// the wire, only decrypted display fields + the patient id.

import "server-only";

import { prisma, type PatientStatus } from "@pharmax/database";
import { searchPatients, type PatientSearchQuery } from "@pharmax/patients";

import { decryptPatientFields } from "./decrypt-patient.js";

export interface PatientSearchRow {
  readonly patientId: string;
  readonly clinicId: string;
  readonly status: PatientStatus;
  readonly cryptoShreddedAt: Date | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly middleName: string | null;
  readonly dateOfBirth: string | null;
  readonly mrn: string | null;
  readonly phiDecryptErrors: boolean;
}

export interface PatientAdminSearchResult {
  readonly rows: ReadonlyArray<PatientSearchRow>;
  readonly tookMs: number;
}

const MAX_DISPLAY_LIMIT = 50;

export async function searchPatientsForAdmin(input: {
  readonly organizationId: string;
  readonly query: PatientSearchQuery;
  readonly includeNonActive?: boolean;
  readonly limit?: number;
}): Promise<PatientAdminSearchResult> {
  const limit = Math.min(input.limit ?? 25, MAX_DISPLAY_LIMIT);
  const result = await searchPatients(prisma, {
    query: input.query,
    limit,
    includeNonActive: input.includeNonActive ?? false,
  });

  const decryptedRows = await Promise.all(
    result.rows.map(async (row) => {
      const decrypted = await decryptPatientFields({
        organizationId: input.organizationId,
        patientId: row.id,
        row,
      });
      return Object.freeze({
        patientId: row.id,
        clinicId: row.clinicId,
        status: row.status,
        cryptoShreddedAt: row.cryptoShreddedAt,
        firstName: decrypted.fields.firstName,
        lastName: decrypted.fields.lastName,
        middleName: decrypted.fields.middleName,
        dateOfBirth: decrypted.fields.dateOfBirth,
        mrn: decrypted.fields.mrn,
        phiDecryptErrors: decrypted.phiDecryptErrors,
      });
    })
  );

  return { rows: decryptedRows, tookMs: result.tookMs };
}
