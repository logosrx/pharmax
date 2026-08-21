// Pharmacy-site credential detail — drives `/ops/admin/sites/[siteId]`.
// Go-live G-1 and G-2.
//
// These are the TENANT's credentials, not a prescriber's: the licences
// a board inspector asks for, and the states the site may dispense
// into. Pharmax holds none of them itself.
//
// `enforcementActive` is the fact the page has to lead with. A site with
// no authorized ship states has asserted nothing about where it is
// licensed, so ship-to-state licensure does not apply to it — and an
// operator looking at a site with credentials recorded but no states
// declared would otherwise reasonably assume they were protected.
//
// `licensableStates` is the set a state could be authorized FROM: live
// state pharmacy licences not already authorized. Computed here so the
// form is a picker rather than a free-text field that fails on submit,
// since `SetSiteAuthorizedShipStates` refuses any state without a
// current licence behind it.
//
// PHI: none. Expiry is derived at read time for the same reason as the
// prescriber credentials — see `get-provider-credentials.ts`.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import {
  CredentialStatus,
  SiteCredentialKind,
  readInOrgScope,
  type CredentialVerificationMethod,
  type SiteStatus,
} from "@pharmax/database";

import type { CredentialStanding } from "./get-provider-credentials";

function standingOf(
  status: CredentialStatus,
  expiresAt: Date | null,
  now: Date
): CredentialStanding {
  if (status === CredentialStatus.REVOKED) return "REVOKED";
  if (status === CredentialStatus.SUSPENDED) return "SUSPENDED";
  if (expiresAt === null) return "NO_EXPIRY";
  return expiresAt.getTime() < now.getTime() ? "EXPIRED" : "ACTIVE";
}

export interface SiteCredentialRow {
  readonly credentialId: string;
  readonly kind: SiteCredentialKind;
  readonly state: string | null;
  readonly identifier: string;
  readonly issuedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly standing: CredentialStanding;
  readonly verificationMethod: CredentialVerificationMethod;
}

export interface AuthorizedShipStateRow {
  readonly state: string;
  /** The licence this authorization cites. */
  readonly licenseIdentifier: string;
  /** Derived standing of that licence — a lapsed one is worth flagging. */
  readonly licenseStanding: CredentialStanding;
}

export interface SiteCredentialDetail {
  readonly siteId: string;
  readonly code: string;
  readonly name: string;
  readonly status: SiteStatus;
  readonly credentials: ReadonlyArray<SiteCredentialRow>;
  readonly authorizedShipStates: ReadonlyArray<AuthorizedShipStateRow>;
  /** True once at least one state is declared. See the header. */
  readonly enforcementActive: boolean;
  /** States with a live licence that are not yet authorized. */
  readonly licensableStates: ReadonlyArray<string>;
  /** Orders bound for a state this site is not licensed for. */
  readonly ordersToUnlicensedStates: number;
  /** Orders with no recorded destination — the backfill's remainder. */
  readonly ordersWithNoDestination: number;
}

export async function getSiteCredentials(input: {
  readonly organizationId: string;
  readonly siteId: string;
}): Promise<SiteCredentialDetail | null> {
  const now = new Date();
  const { organizationId, siteId } = input;

  return readInOrgScope(organizationId, async (tx) => {
    const site = await tx.pharmacySite.findFirst({
      where: { id: siteId, organizationId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        credentials: {
          select: {
            id: true,
            kind: true,
            state: true,
            identifier: true,
            issuedAt: true,
            expiresAt: true,
            status: true,
            verificationMethod: true,
          },
          orderBy: [{ kind: "asc" }, { state: "asc" }],
        },
        authorizedShipStates: {
          select: {
            state: true,
            licenseCredential: {
              select: { identifier: true, status: true, expiresAt: true },
            },
          },
          orderBy: { state: "asc" },
        },
      },
    });
    if (site === null) return null;

    const authorizedStates = new Set(site.authorizedShipStates.map((s) => s.state));

    // Live state licences: ACTIVE and either no recorded expiry or an
    // expiry in the future. Matches what SetSiteAuthorizedShipStates
    // accepts, so the picker cannot offer a state the command refuses.
    const licensableStates = site.credentials
      .filter(
        (c) =>
          c.kind === SiteCredentialKind.STATE_PHARMACY_LICENSE &&
          c.status === CredentialStatus.ACTIVE &&
          c.state !== null &&
          (c.expiresAt === null || c.expiresAt.getTime() >= now.getTime()) &&
          !authorizedStates.has(c.state)
      )
      .map((c) => c.state!)
      .sort();

    // Two counts that tell an operator what switching enforcement on
    // would actually refuse. Cheap because
    // `(organizationId, siteId, destinationState)` is indexed.
    const [ordersToUnlicensedStates, ordersWithNoDestination] = await Promise.all([
      authorizedStates.size === 0
        ? Promise.resolve(0)
        : tx.order.count({
            where: {
              organizationId,
              siteId,
              destinationState: { notIn: [...authorizedStates] },
              currentStatus: { notIn: ["SHIPPED", "CANCELLED"] },
            },
          }),
      tx.order.count({
        where: {
          organizationId,
          siteId,
          destinationState: null,
          currentStatus: { notIn: ["SHIPPED", "CANCELLED"] },
        },
      }),
    ]);

    return Object.freeze({
      siteId: site.id,
      code: site.code,
      name: site.name,
      status: site.status,
      credentials: Object.freeze(
        site.credentials.map((c) =>
          Object.freeze({
            credentialId: c.id,
            kind: c.kind,
            state: c.state,
            identifier: c.identifier,
            issuedAt: c.issuedAt,
            expiresAt: c.expiresAt,
            standing: standingOf(c.status, c.expiresAt, now),
            verificationMethod: c.verificationMethod,
          })
        )
      ),
      authorizedShipStates: Object.freeze(
        site.authorizedShipStates.map((s) =>
          Object.freeze({
            state: s.state,
            licenseIdentifier: s.licenseCredential.identifier,
            licenseStanding: standingOf(
              s.licenseCredential.status,
              s.licenseCredential.expiresAt,
              now
            ),
          })
        )
      ),
      enforcementActive: authorizedStates.size > 0,
      licensableStates: Object.freeze(licensableStates),
      ordersToUnlicensedStates,
      ordersWithNoDestination,
    });
  });
}
