// Clinic (practice) directory projection — drives `/ops/admin/practices`.
//
// Lists every clinic in the operator's organization with its
// pharmacy-site links and roster/order counts. Clinics per org are
// bounded (dozens, not thousands) so this is a full list — no cursor.
//
// PHI: none — clinic code/name/status, site codes, and aggregate
// counts only. Patient identity never surfaces here.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import { readInOrgScope, type ClinicStatus } from "@pharmax/database";

export interface ClinicSiteLink {
  readonly siteCode: string;
  readonly siteName: string;
  readonly isPrimary: boolean;
}

export interface ClinicListRow {
  readonly clinicId: string;
  readonly code: string;
  readonly name: string;
  readonly status: ClinicStatus;
  readonly sites: ReadonlyArray<ClinicSiteLink>;
  /** Aggregate roster size — a count, not PHI. */
  readonly patientCount: number;
  readonly orderCount: number;
  readonly createdAt: Date;
}

export async function listClinics(input: {
  readonly organizationId: string;
}): Promise<ReadonlyArray<ClinicListRow>> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const rows = await tx.clinic.findMany({
      where: { organizationId: input.organizationId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        createdAt: true,
        siteLinks: {
          select: {
            isPrimary: true,
            site: { select: { code: true, name: true } },
          },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        },
        _count: { select: { patients: true, orders: true } },
      },
      orderBy: [{ status: "asc" }, { code: "asc" }],
    });

    return rows.map((r) =>
      Object.freeze({
        clinicId: r.id,
        code: r.code,
        name: r.name,
        status: r.status,
        sites: r.siteLinks.map((l) =>
          Object.freeze({
            siteCode: l.site.code,
            siteName: l.site.name,
            isPrimary: l.isPrimary,
          })
        ),
        patientCount: r._count.patients,
        orderCount: r._count.orders,
        createdAt: r.createdAt,
      })
    );
  });
}
