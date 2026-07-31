// Provider (prescriber) directory projection — drives
// `/ops/admin/providers`.
//
// Paginated list of the org's provider roster ordered by last name.
// Supports an optional status filter and a `q` filter matched
// against last name (contains, case-insensitive) or NPI prefix.
//
// PHI: none — provider identity (NPI, name, credential, practice
// contact) is public registry data per HIPAA Safe Harbor.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import { readInOrgScope, type ProviderStatus } from "@pharmax/database";

export interface ProviderListRow {
  readonly providerId: string;
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly credential: string | null;
  readonly deaNumber: string | null;
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

export async function listProviders(options: ListProvidersOptions): Promise<ListProvidersResult> {
  const limit = Math.min(options.limit ?? 50, 200);

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
        deaNumber: true,
        phone: true,
        city: true,
        state: true,
        status: true,
        createdAt: true,
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
          deaNumber: r.deaNumber,
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
