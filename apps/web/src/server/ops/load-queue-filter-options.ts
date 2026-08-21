// Client and site options for the queue filter toolbar.
//
// Both lists are small and change rarely — a pharmacy has a handful of
// sites and tens to low hundreds of clients — so this is one indexed
// read of two narrow tables per queue render, sharing a single
// transaction.
//
// ACTIVE ONLY, with one exception that matters: a clinic can be
// deactivated while its orders are still in the queue, and dropping it
// from the filter list would leave those orders unfilterable. So the
// caller's currently-selected clinic is always included even if it is no
// longer active, which is why `selectedClinicId` exists.
//
// PHI: none. Client and site names are business identifiers.

import "server-only";

import { readInOrgScope } from "@pharmax/database";

export interface QueueFilterOptions {
  readonly clinics: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly sites: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

export async function loadQueueFilterOptions(input: {
  readonly organizationId: string;
  /** Kept in the list even if deactivated. See the header. */
  readonly selectedClinicId?: string;
}): Promise<QueueFilterOptions> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const clinicWhere =
      input.selectedClinicId === undefined
        ? { organizationId: input.organizationId, status: "ACTIVE" as const }
        : {
            organizationId: input.organizationId,
            OR: [{ status: "ACTIVE" as const }, { id: input.selectedClinicId }],
          };

    const [clinics, sites] = await Promise.all([
      tx.clinic.findMany({
        where: clinicWhere,
        select: { id: true, code: true, name: true },
        orderBy: { name: "asc" },
        // A pharmacy with more than this many active clients needs a
        // typeahead, not a longer dropdown. Capping keeps one slow
        // tenant from making every queue render slow.
        take: 200,
      }),
      tx.pharmacySite.findMany({
        where: { organizationId: input.organizationId, status: "ACTIVE" },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
        take: 50,
      }),
    ]);

    return Object.freeze({
      clinics: Object.freeze(
        clinics.map((c) => Object.freeze({ id: c.id, label: `${c.code} · ${c.name}` }))
      ),
      sites: Object.freeze(
        sites.map((s) => Object.freeze({ id: s.id, label: `${s.code} · ${s.name}` }))
      ),
    });
  });
}
