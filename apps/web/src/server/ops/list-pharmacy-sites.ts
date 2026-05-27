// Pharmacy-site admin projection — drives `/ops/admin/sites`.
//
// Lists every PharmacySite in the operator's organization,
// including the address fields. `addressComplete` is a computed
// boolean that the shipping queue can also use to decide whether
// to surface the carrier auto-purchase form.

import "server-only";

import { prisma, type SiteStatus } from "@pharmax/database";

export interface PharmacySiteRow {
  readonly siteId: string;
  readonly code: string;
  readonly name: string;
  readonly status: SiteStatus;
  readonly timezone: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string;
  readonly phone: string | null;
  /** True iff every required ship-from field is populated. */
  readonly addressComplete: boolean;
}

function computeAddressComplete(row: {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
}): boolean {
  return (
    row.addressLine1 !== null &&
    row.addressLine1.length > 0 &&
    row.city !== null &&
    row.city.length > 0 &&
    row.state !== null &&
    row.state.length > 0 &&
    row.postalCode !== null &&
    row.postalCode.length > 0 &&
    row.country.length > 0
  );
}

export async function listPharmacySites(input: {
  readonly organizationId: string;
}): Promise<ReadonlyArray<PharmacySiteRow>> {
  const rows = await prisma.pharmacySite.findMany({
    where: { organizationId: input.organizationId },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      timezone: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      phone: true,
    },
    orderBy: [{ status: "asc" }, { code: "asc" }],
  });

  return rows.map((r) =>
    Object.freeze({
      siteId: r.id,
      code: r.code,
      name: r.name,
      status: r.status,
      timezone: r.timezone,
      addressLine1: r.addressLine1,
      addressLine2: r.addressLine2,
      city: r.city,
      state: r.state,
      postalCode: r.postalCode,
      country: r.country,
      phone: r.phone,
      addressComplete: computeAddressComplete(r),
    })
  );
}
