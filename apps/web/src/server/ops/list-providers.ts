// Provider (prescriber) directory projection — drives
// `/ops/admin/providers`.
//
// Paginated list of the org's provider roster ordered by last name.
// Supports an optional status filter and a `q` filter matched
// against last name (contains, case-insensitive) or NPI prefix.
//
// PHI: none — provider identity (NPI, name, credential, practice
// contact) is public registry data per HIPAA Safe Harbor.
//
// DEA NUMBERS ARE NOT RETURNED HERE, and that is a change. This
// projection used to carry the plaintext number and the admin table
// rendered it in a column, which sat oddly beside the write path:
// `RegisterProvider` redacts `deaNumber` from `command_log`
// specifically because a forensic dump of prescribing credentials is a
// prescription-fraud tool. Showing the same string to every holder of
// `providers.read` undid that.
//
// What a roster view actually needs is whether the prescriber CAN
// write controlled substances, not the credential itself — so this
// returns a summary. The number lives on the credential surface,
// behind `providers.credentials.read`.
//
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import { CredentialStatus, readInOrgScope, type ProviderStatus } from "@pharmax/database";

/**
 * Roster-level view of a prescriber's DEA standing. Deliberately says
 * nothing about which number: `hasActive` answers "may they write
 * controlled substances", `soonestExpiresAt` answers "is that about to
 * stop being true", and both are answerable without the credential.
 */
export interface ProviderDeaSummary {
  /** At least one ACTIVE registration that has not passed its expiry. */
  readonly hasActive: boolean;
  /** Registrations on file at all, including revoked and lapsed. */
  readonly total: number;
  /** Earliest recorded expiry among live registrations, if any. */
  readonly soonestExpiresAt: Date | null;
  /** True when a registration exists but none is currently usable. */
  readonly hasLapsed: boolean;
}

export interface ProviderListRow {
  readonly providerId: string;
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly credential: string | null;
  readonly dea: ProviderDeaSummary;
  readonly phone: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly status: ProviderStatus;
  readonly createdAt: Date;
}

export interface ListProvidersOptions {
  readonly organizationId: string;
  readonly status?: ProviderStatus;
  /** Matches last name (contains, case-insensitive) or NPI prefix. */
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListProvidersResult {
  readonly rows: ReadonlyArray<ProviderListRow>;
  /** Cursor for the next page; null when no more rows. */
  readonly nextCursor: string | null;
}

/**
 * Fold a prescriber's registrations into the roster summary.
 *
 * A null `expiresAt` counts as live: it means nobody recorded a date,
 * which is a gap to close rather than a lapse to report. Treating it
 * as expired here would light up the whole roster red for any tenant
 * that migrated numbers without dates, and a warning everyone ignores
 * is worse than no warning.
 */
function summarizeDea(
  registrations: ReadonlyArray<{
    readonly status: CredentialStatus;
    readonly expiresAt: Date | null;
  }>,
  now: Date
): ProviderDeaSummary {
  let hasActive = false;
  let soonestExpiresAt: Date | null = null;

  for (const registration of registrations) {
    if (registration.status !== CredentialStatus.ACTIVE) continue;
    if (registration.expiresAt !== null && registration.expiresAt.getTime() < now.getTime()) {
      continue;
    }
    hasActive = true;
    if (
      registration.expiresAt !== null &&
      (soonestExpiresAt === null || registration.expiresAt < soonestExpiresAt)
    ) {
      soonestExpiresAt = registration.expiresAt;
    }
  }

  return Object.freeze({
    hasActive,
    total: registrations.length,
    soonestExpiresAt,
    hasLapsed: registrations.length > 0 && !hasActive,
  });
}

export async function listProviders(options: ListProvidersOptions): Promise<ListProvidersResult> {
  const limit = Math.min(options.limit ?? 50, 200);
  const now = new Date();

  return readInOrgScope(options.organizationId, async (tx) => {
    const rows = await tx.provider.findMany({
      where: {
        organizationId: options.organizationId,
        ...(options.status !== undefined ? { status: options.status } : {}),
        ...(options.q !== undefined
          ? {
              OR: [
                { lastName: { contains: options.q, mode: "insensitive" } },
                { npi: { startsWith: options.q } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        npi: true,
        firstName: true,
        lastName: true,
        credential: true,
        phone: true,
        city: true,
        state: true,
        status: true,
        createdAt: true,
        // Status and expiry only. The number itself is never selected
        // here, so it cannot leak into this projection by accident.
        deaRegistrations: {
          select: { status: true, expiresAt: true },
        },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(options.cursor !== undefined ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? sliced[sliced.length - 1]!.id : null;

    return Object.freeze({
      rows: sliced.map((r) =>
        Object.freeze({
          providerId: r.id,
          npi: r.npi,
          firstName: r.firstName,
          lastName: r.lastName,
          credential: r.credential,
          dea: summarizeDea(r.deaRegistrations, now),
          phone: r.phone,
          city: r.city,
          state: r.state,
          status: r.status,
          createdAt: r.createdAt,
        })
      ),
      nextCursor,
    });
  });
}
