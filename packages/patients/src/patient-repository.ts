// PatientRepository — the supported read path for Patient rows.
//
// Extends `ScopedRepository` so:
//
//   * The Prisma extension auto-injects `organizationId = ctx.org` on
//     every query; this class never has to mention it.
//   * Transaction participation goes through `withTx(tx)` so the
//     command bus's outer `$transaction` block reuses one connection.
//
// What this repository does:
//
//   * `findById` — exact-id lookup. Returns `null` for "not in this
//     tenant" (the extension does the filtering); we don't expose
//     a "wrong tenant" vs "not found" distinction to the caller.
//
//   * `findByIdOrThrow` — convenience for command handlers that
//     have already asserted the patient must exist.
//
//   * `listByClinic` — bounded list of patients for a clinic. Sort
//     order is `createdAt DESC` so admin / inactive-patient sweep
//     screens see the freshest rows first.
//
// What this repository deliberately does NOT do:
//
//   * Search by anything other than id / clinicId. Use
//     `searchPatients` (in `search-patients.ts`); it understands
//     blind-index normalization.
//
//   * Create / update / shred. Those go through command handlers in
//     `@pharmax/patient-commands` (a separate package, not yet
//     landed) so they participate in the bus's audit / outbox flow.
//
//   * Decrypt. Decryption lives in `@pharmax/crypto::decryptField`
//     and is called by the read-model projector for the specific
//     fields a UI needs to display.

import type { Patient, PrismaClient } from "@pharmax/database";
import { ScopedRepository } from "@pharmax/tenancy";

/** Subset of `PrismaClient` that exposes the `patient` delegate. */
type PatientCapableClient = Pick<PrismaClient, "patient">;
/** The `prisma.patient` delegate type — what `ScopedRepository`
 * actually holds. */
type PatientDelegate = PatientCapableClient["patient"];

/**
 * Constants tuning the read path. Adjust here, never inside the
 * methods, so a change is visible in PR review.
 */
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export interface PatientRepositoryListOptions {
  readonly clinicId: string;
  /** Page size; clamped to `[1, 200]`. */
  readonly limit?: number;
  /** Skip the first N rows. Use sparingly — keyset pagination is
   * cheaper for deep pages but offset is fine for the admin UI. */
  readonly skip?: number;
  /** Whether to include MERGED / INACTIVE / DECEASED rows. Default
   * is false; the typical caller is the day-to-day intake UI. */
  readonly includeNonActive?: boolean;
}

export class PatientRepository extends ScopedRepository<PatientDelegate> {
  private constructor(delegate: PatientDelegate) {
    super(delegate);
  }

  static fromPrisma(prisma: PatientCapableClient): PatientRepository {
    return new PatientRepository(prisma.patient);
  }

  override withTx(tx: PrismaClient): PatientRepository {
    return new PatientRepository(tx.patient);
  }

  /**
   * Look up a patient by primary key. Returns `null` if the row is
   * not in the active tenant (the extension filter is the gate;
   * "tenant mismatch" and "not found" are deliberately conflated
   * to avoid an identifier-existence oracle).
   */
  async findById(id: string): Promise<Patient | null> {
    return this.delegate.findUnique({ where: { id } });
  }

  /**
   * Convenience for command handlers that have already validated
   * the patient must exist. Throws a domain `Error` rather than
   * letting an undefined-property TypeError bubble up downstream.
   */
  async findByIdOrThrow(id: string): Promise<Patient> {
    const row = await this.findById(id);
    if (row === null) {
      throw new Error(`@pharmax/patients: patient ${JSON.stringify(id)} not found in tenant`);
    }
    return row;
  }

  /**
   * Page of patients for a given clinic. Filtered by status by
   * default. Ordering is stable (`createdAt DESC, id ASC`) so a
   * paged scan can resume on the next call.
   */
  async listByClinic(options: PatientRepositoryListOptions): Promise<Patient[]> {
    const limit = clamp(options.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const includeNonActive = options.includeNonActive ?? false;
    return this.delegate.findMany({
      where: {
        clinicId: options.clinicId,
        ...(includeNonActive ? {} : { status: "ACTIVE" as const }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit,
      ...(options.skip !== undefined ? { skip: options.skip } : {}),
    });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return Math.trunc(n);
}
