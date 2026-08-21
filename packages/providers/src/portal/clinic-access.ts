// Which client practices a prescriber may act for, in the portal.
//
// One query, two callers, deliberately shared:
//
//   - PortalSignIn, to decide whether to mint a session already scoped
//     to the single affiliation, or leave it unscoped and send the
//     prescriber to the chooser.
//   - SwitchPortalClinic and the chooser page, to render and validate
//     the candidate list.
//
// Sharing matters more than the line count saved. If sign-in and the
// switch command each had their own notion of "may act for", they could
// disagree — and the shape of that disagreement is a prescriber offered
// a client they cannot actually select, or worse, able to select one
// the roster does not grant.
//
// BOTH sides must be live: the affiliation ACTIVE and the client
// ACTIVE. An affiliation with a deactivated client is not access to
// anything, and offering it in a chooser would produce a session
// scoped to a client that cannot receive orders.
//
// Runs against a caller-supplied `tx`. Callers are responsible for the
// system-context frame (portal principals have no tenancy frame — the
// session row is the tenancy proof), which is why every query here is
// explicitly org-scoped.

import { ClinicProviderAffiliationStatus, ClinicStatus, type Prisma } from "@pharmax/database";

export interface PortalClinicOption {
  readonly clinicId: string;
  readonly code: string;
  readonly name: string;
}

type AffiliationDelegateClient = Pick<Prisma.TransactionClient, "clinicProviderAffiliation">;

/**
 * The client practices this prescriber may currently act for, ordered
 * by name so the chooser is stable between renders.
 */
export async function listPortalClinicOptions(input: {
  readonly tx: AffiliationDelegateClient;
  readonly organizationId: string;
  readonly providerId: string;
}): Promise<ReadonlyArray<PortalClinicOption>> {
  const rows = await input.tx.clinicProviderAffiliation.findMany({
    where: {
      organizationId: input.organizationId,
      providerId: input.providerId,
      status: ClinicProviderAffiliationStatus.ACTIVE,
      clinic: { status: ClinicStatus.ACTIVE },
    },
    select: { clinic: { select: { id: true, code: true, name: true } } },
    orderBy: { clinic: { name: "asc" } },
  });

  return Object.freeze(
    rows.map((row) => ({
      clinicId: row.clinic.id,
      code: row.clinic.code,
      name: row.clinic.name,
    }))
  );
}

/**
 * Whether this prescriber may act for one specific client. Used by
 * SwitchPortalClinic, where the candidate arrives from a form post and
 * so is caller-controlled until proven.
 */
export async function canActForClinic(input: {
  readonly tx: AffiliationDelegateClient;
  readonly organizationId: string;
  readonly providerId: string;
  readonly clinicId: string;
}): Promise<boolean> {
  const row = await input.tx.clinicProviderAffiliation.findFirst({
    where: {
      organizationId: input.organizationId,
      providerId: input.providerId,
      clinicId: input.clinicId,
      status: ClinicProviderAffiliationStatus.ACTIVE,
      clinic: { status: ClinicStatus.ACTIVE },
    },
    select: { id: true },
  });
  return row !== null;
}
