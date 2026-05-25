// PHI-safe patient search.
//
// Search proceeds via blind-index columns ONLY. The plaintext side
// of every field exists in encrypted JSON; we cannot index it
// without decrypting it, which would build a giant cross-tenant
// PHI exposure point.
//
// The function below is the SINGLE supported way to look up patients
// by anything other than primary key. Any other lookup path is
// either:
//
//   * `findUnique({ where: { id } })` — id-only, no normalization
//     concerns; tenancy extension still enforces scope.
//   * `<reporting>` — aggregations that don't touch PHI.
//
// Threat model recap (verbatim from `blind-index.ts` in @pharmax/crypto):
//
//   "Frequency analysis remains possible inside one tenant: if 'John
//    Smith' appears 100 times, all 100 rows share the same blind
//    index hash. We accept this; document this limitation loudly in
//    the patient-search code that USES blind indexes."
//
// We document it here:
//
//   The search response is intentionally `tookMs`-only (no `total`).
//   Callers that page the result MUST also project (decrypt) the
//   page to confirm matches — two patients can share a hash for the
//   same name and still differ on DOB; trusting the hash alone is a
//   security bug.

import type { Patient, Prisma, PrismaClient } from "@pharmax/database";
import { requireCurrentContext } from "@pharmax/tenancy";

import { PATIENT_BLIND_INDEX } from "./blind-indexes.js";
import type { PatientSearchQuery, PatientSearchResult } from "./types.js";

/**
 * Default page size. Picked to be small enough that a reasonable
 * user can scan the result with a name+DOB confirmation but large
 * enough that legitimate matches aren't dropped. Override per call
 * when intake / merge UIs need a different bound.
 */
export const DEFAULT_PATIENT_SEARCH_LIMIT = 25;
/** Hard ceiling; protects against an upstream `limit: 1_000_000`. */
export const MAX_PATIENT_SEARCH_LIMIT = 100;

export interface PatientSearchOptions {
  readonly query: PatientSearchQuery;
  /** Optional clinic filter on top of the org filter the extension
   * already injects. Useful when the caller is a clinic-scoped role. */
  readonly clinicId?: string;
  /** Page size. Clamped to `[1, MAX_PATIENT_SEARCH_LIMIT]`. */
  readonly limit?: number;
  /** Whether to include patients in MERGED/INACTIVE/DECEASED status.
   * Default: false. Merge UIs flip this to true. */
  readonly includeNonActive?: boolean;
}

/**
 * Search patients in the active tenant by blind-index lookup.
 *
 * Returns full Patient rows (envelopes still encrypted). Callers
 * decrypt the fields they actually need to display — typeahead
 * decrypts names; merge UI decrypts names + DOB; full chart pulls
 * everything. Never decrypts on behalf of the caller.
 *
 * Refuses to run if no field of the query is set — we don't
 * dispense unbounded patient scans.
 */
export async function searchPatients(
  prisma: PrismaClient,
  options: PatientSearchOptions
): Promise<PatientSearchResult<Patient>> {
  const start = Date.now();
  const ctx = requireCurrentContext();

  const where = await buildSearchWhere({
    tenantId: ctx.organizationId,
    query: options.query,
    ...(options.clinicId !== undefined ? { clinicId: options.clinicId } : {}),
    includeNonActive: options.includeNonActive ?? false,
  });

  if (where === null) {
    throw new Error(
      "@pharmax/patients: searchPatients requires at least one query field to be set"
    );
  }

  const limit = clamp(options.limit ?? DEFAULT_PATIENT_SEARCH_LIMIT, 1, MAX_PATIENT_SEARCH_LIMIT);

  // The tenancy extension auto-injects `organizationId = ctx.organizationId`,
  // so we don't include it in `where` here.
  const rows = await prisma.patient.findMany({
    where,
    take: limit,
    orderBy: [{ createdAt: "desc" }],
  });

  return {
    rows,
    tookMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------
// Internals — exported so unit tests can drive them without a DB.

/**
 * Translate a `PatientSearchQuery` into a Prisma `where` clause. The
 * shape exploits the existing `(organizationId, *Bi)` btree indexes:
 * every condition is an equality on a blind-index column, AND-joined
 * across fields. Returns `null` if the query has no usable fields
 * (no non-empty inputs, or every input failed normalization).
 *
 * Exported for tests; production code should use `searchPatients`.
 */
export async function buildSearchWhere(args: {
  readonly tenantId: string;
  readonly query: PatientSearchQuery;
  readonly clinicId?: string;
  readonly includeNonActive: boolean;
}): Promise<Prisma.PatientWhereInput | null> {
  const conditions: Prisma.PatientWhereInput[] = [];

  if (args.query.lastName) {
    const hash = await PATIENT_BLIND_INDEX.lastName({
      tenantId: args.tenantId,
      value: args.query.lastName,
    });
    if (hash !== null) conditions.push({ lastNameBi: hash });
  }
  if (args.query.firstName) {
    const hash = await PATIENT_BLIND_INDEX.firstName({
      tenantId: args.tenantId,
      value: args.query.firstName,
    });
    if (hash !== null) conditions.push({ firstNameBi: hash });
  }
  if (args.query.dateOfBirth) {
    const hash = await PATIENT_BLIND_INDEX.dateOfBirth({
      tenantId: args.tenantId,
      value: args.query.dateOfBirth,
    });
    if (hash !== null) conditions.push({ dobBi: hash });
  }
  if (args.query.dateOfBirthYearMonth) {
    const hash = await PATIENT_BLIND_INDEX.dateOfBirthYearMonth({
      tenantId: args.tenantId,
      value: args.query.dateOfBirthYearMonth,
    });
    if (hash !== null) conditions.push({ dobYearMonthBi: hash });
  }
  if (args.query.phone) {
    const hash = await PATIENT_BLIND_INDEX.phoneLast10({
      tenantId: args.tenantId,
      value: args.query.phone,
    });
    if (hash !== null) conditions.push({ phoneLast10Bi: hash });
  }
  if (args.query.email) {
    const hash = await PATIENT_BLIND_INDEX.email({
      tenantId: args.tenantId,
      value: args.query.email,
    });
    if (hash !== null) conditions.push({ emailBi: hash });
  }
  if (args.query.postalCode) {
    const hash = await PATIENT_BLIND_INDEX.postalCode({
      tenantId: args.tenantId,
      value: args.query.postalCode,
    });
    if (hash !== null) conditions.push({ postalCodeBi: hash });
  }
  if (args.query.mrn) {
    const hash = await PATIENT_BLIND_INDEX.mrn({
      tenantId: args.tenantId,
      value: args.query.mrn,
    });
    if (hash !== null) conditions.push({ mrnBi: hash });
  }

  if (conditions.length === 0) return null;

  const where: Prisma.PatientWhereInput = { AND: conditions };
  if (args.clinicId !== undefined) where.clinicId = args.clinicId;
  if (!args.includeNonActive) where.status = "ACTIVE";
  return where;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return Math.trunc(n);
}
