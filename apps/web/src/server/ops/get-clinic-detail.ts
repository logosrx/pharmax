// Client (practice) detail projection — drives
// `/ops/admin/practices/[clinicId]`.
//
// Carries the client's directory record, its pharmacy-site links, and
// its prescriber roster: who may currently write for it, plus the
// affiliations that have ended and why. The ended rows are included on
// purpose — "who could prescribe for this client, and who stopped" is
// the question an access review asks, and answering it from a screen is
// cheaper than answering it from the audit log.
//
// Also returns the ACTIVE prescribers NOT yet affiliated, so the add
// form is a picker rather than a uuid field.
//
// PHI: none. Prescriber identity is public NPI-registry data, and no
// patient row is referenced — only aggregate counts.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import {
  ClinicProviderAffiliationStatus,
  ProviderStatus,
  readInOrgScope,
  type ClinicStatus,
} from "@pharmax/database";

export interface ClinicSiteDetail {
  readonly siteCode: string;
  readonly siteName: string;
  readonly isPrimary: boolean;
}

export interface ClinicProviderRow {
  readonly affiliationId: string;
  readonly providerId: string;
  readonly npi: string;
  readonly displayName: string;
  readonly credential: string | null;
  readonly providerStatus: ProviderStatus;
  readonly affiliatedAt: Date;
}

export interface ClinicEndedProviderRow extends ClinicProviderRow {
  readonly endedAt: Date;
  readonly endedReason: string;
}

export interface AffiliatableProvider {
  readonly providerId: string;
  readonly npi: string;
  readonly displayName: string;
}

export interface ClinicDetail {
  readonly clinicId: string;
  readonly code: string;
  readonly name: string;
  readonly status: ClinicStatus;
  readonly createdAt: Date;
  readonly sites: ReadonlyArray<ClinicSiteDetail>;
  readonly patientCount: number;
  readonly orderCount: number;
  /** Orders not yet SHIPPED or CANCELLED — what blocks archiving. */
  readonly inFlightOrderCount: number;
  readonly activeProviders: ReadonlyArray<ClinicProviderRow>;
  readonly endedProviders: ReadonlyArray<ClinicEndedProviderRow>;
  readonly affiliatableProviders: ReadonlyArray<AffiliatableProvider>;
}

function displayName(p: {
  readonly firstName: string;
  readonly lastName: string;
  readonly credential?: string | null;
}): string {
  const credential = p.credential ?? null;
  return `${p.firstName} ${p.lastName}${credential === null ? "" : `, ${credential}`}`;
}

export async function getClinicDetail(input: {
  readonly organizationId: string;
  readonly clinicId: string;
}): Promise<ClinicDetail | null> {
  const { organizationId, clinicId } = input;

  return readInOrgScope(organizationId, async (tx) => {
    const clinic = await tx.clinic.findFirst({
      where: { id: clinicId, organizationId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        createdAt: true,
        siteLinks: {
          select: { isPrimary: true, site: { select: { code: true, name: true } } },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        },
        _count: { select: { patients: true, orders: true } },
      },
    });
    if (clinic === null) return null;

    const [affiliations, inFlightOrderCount, allActiveProviders] = await Promise.all([
      tx.clinicProviderAffiliation.findMany({
        where: { organizationId, clinicId },
        select: {
          id: true,
          status: true,
          affiliatedAt: true,
          endedAt: true,
          endedReason: true,
          provider: {
            select: {
              id: true,
              npi: true,
              firstName: true,
              lastName: true,
              credential: true,
              status: true,
            },
          },
        },
        orderBy: [{ status: "asc" }, { affiliatedAt: "desc" }],
      }),
      tx.order.count({
        where: {
          organizationId,
          clinicId,
          currentStatus: { notIn: ["SHIPPED", "CANCELLED"] },
        },
      }),
      tx.provider.findMany({
        where: { organizationId, status: ProviderStatus.ACTIVE },
        select: { id: true, npi: true, firstName: true, lastName: true, credential: true },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      }),
    ]);

    const activeProviders: ClinicProviderRow[] = [];
    const endedProviders: ClinicEndedProviderRow[] = [];
    const affiliatedProviderIds = new Set<string>();

    for (const row of affiliations) {
      const base = {
        affiliationId: row.id,
        providerId: row.provider.id,
        npi: row.provider.npi,
        displayName: displayName(row.provider),
        credential: row.provider.credential,
        providerStatus: row.provider.status,
        affiliatedAt: row.affiliatedAt,
      };
      if (row.status === ClinicProviderAffiliationStatus.ACTIVE) {
        affiliatedProviderIds.add(row.provider.id);
        activeProviders.push(Object.freeze(base));
      } else if (row.endedAt !== null && row.endedReason !== null) {
        // The ENDED-consistency CHECK constraint guarantees both are
        // present on an ENDED row; the narrowing satisfies the types
        // without asserting.
        endedProviders.push(
          Object.freeze({ ...base, endedAt: row.endedAt, endedReason: row.endedReason })
        );
      }
    }

    return Object.freeze({
      clinicId: clinic.id,
      code: clinic.code,
      name: clinic.name,
      status: clinic.status,
      createdAt: clinic.createdAt,
      sites: clinic.siteLinks.map((l) =>
        Object.freeze({
          siteCode: l.site.code,
          siteName: l.site.name,
          isPrimary: l.isPrimary,
        })
      ),
      patientCount: clinic._count.patients,
      orderCount: clinic._count.orders,
      inFlightOrderCount,
      activeProviders: Object.freeze(activeProviders),
      endedProviders: Object.freeze(endedProviders),
      affiliatableProviders: Object.freeze(
        allActiveProviders
          .filter((p) => !affiliatedProviderIds.has(p.id))
          .map((p) =>
            Object.freeze({
              providerId: p.id,
              npi: p.npi,
              displayName: displayName(p),
            })
          )
      ),
    });
  });
}
