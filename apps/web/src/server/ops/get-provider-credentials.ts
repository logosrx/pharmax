// Prescriber credential detail — drives `/ops/admin/providers/[providerId]`.
//
// THE DEA NUMBER IS RETURNED HERE, unlike in `list-providers.ts` where it
// is deliberately not. The roster answers "may this prescriber write
// controlled substances" for everyone with `providers.read`; this
// projection answers "what exactly is on file" and the page gates it on
// `providers.credentials.read`. Two questions, two audiences, two
// grants.
//
// EXPIRY IS DERIVED, NOT STORED. `CredentialStatus` has no EXPIRED
// member on purpose — expiry is a fact about a date and the current
// time, so computing it at read time cannot go stale. A stored value
// would need a sweeper, and the window between a registration lapsing
// and the sweeper noticing is exactly when a controlled prescription
// must not be written.
//
// PHI: none. Prescriber identity is public NPI-registry data. A DEA
// number is not PHI either, but it IS a controlled-substance
// prescribing credential — see the permission note above.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import {
  CredentialStatus,
  readInOrgScope,
  type ControlledSubstanceSchedule,
  type CredentialVerificationMethod,
  type DeaRegistrantType,
  type ProviderStatus,
} from "@pharmax/database";

/** Derived standing, combining stored status with the expiry date. */
export type CredentialStanding = "ACTIVE" | "EXPIRED" | "REVOKED" | "SUSPENDED" | "NO_EXPIRY";

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

export interface ProviderDeaRegistrationRow {
  readonly registrationId: string;
  readonly deaNumber: string;
  readonly registrantType: DeaRegistrantType;
  readonly authorizedSchedules: ReadonlyArray<ControlledSubstanceSchedule>;
  readonly issuedState: string | null;
  readonly issuedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly standing: CredentialStanding;
  readonly verificationMethod: CredentialVerificationMethod;
  readonly recordedByEmail: string | null;
}

export interface ProviderStateLicenseRow {
  readonly licenseId: string;
  readonly state: string;
  readonly licenseNumber: string;
  readonly licenseType: string | null;
  readonly issuedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly standing: CredentialStanding;
  readonly verificationMethod: CredentialVerificationMethod;
  readonly recordedByEmail: string | null;
}

export interface ProviderCredentialDetail {
  readonly providerId: string;
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly credential: string | null;
  readonly status: ProviderStatus;
  readonly deaRegistrations: ReadonlyArray<ProviderDeaRegistrationRow>;
  readonly stateLicenses: ReadonlyArray<ProviderStateLicenseRow>;
  /** Clients this prescriber may currently write for. */
  readonly activeClinics: ReadonlyArray<{ readonly code: string; readonly name: string }>;
}

export async function getProviderCredentials(input: {
  readonly organizationId: string;
  readonly providerId: string;
}): Promise<ProviderCredentialDetail | null> {
  const now = new Date();

  return readInOrgScope(input.organizationId, async (tx) => {
    const provider = await tx.provider.findFirst({
      where: { id: input.providerId, organizationId: input.organizationId },
      select: {
        id: true,
        npi: true,
        firstName: true,
        lastName: true,
        credential: true,
        status: true,
        deaRegistrations: {
          select: {
            id: true,
            deaNumber: true,
            registrantType: true,
            authorizedSchedules: true,
            issuedState: true,
            issuedAt: true,
            expiresAt: true,
            status: true,
            verificationMethod: true,
            // Null for rows migrated out of the legacy column, which
            // recorded no actor. Rendered as "migrated" rather than
            // blank so the gap is legible.
            recordedByUser: { select: { email: true } },
          },
          orderBy: [{ status: "asc" }, { expiresAt: "asc" }],
        },
        stateLicenses: {
          select: {
            id: true,
            state: true,
            licenseNumber: true,
            licenseType: true,
            issuedAt: true,
            expiresAt: true,
            status: true,
            verificationMethod: true,
            recordedByUser: { select: { email: true } },
          },
          orderBy: [{ status: "asc" }, { state: "asc" }],
        },
        clinicAffiliations: {
          where: { status: "ACTIVE" },
          select: { clinic: { select: { code: true, name: true } } },
          orderBy: { clinic: { name: "asc" } },
        },
      },
    });
    if (provider === null) return null;

    return Object.freeze({
      providerId: provider.id,
      npi: provider.npi,
      firstName: provider.firstName,
      lastName: provider.lastName,
      credential: provider.credential,
      status: provider.status,
      deaRegistrations: Object.freeze(
        provider.deaRegistrations.map((r) =>
          Object.freeze({
            registrationId: r.id,
            deaNumber: r.deaNumber,
            registrantType: r.registrantType,
            authorizedSchedules: Object.freeze([...r.authorizedSchedules]),
            issuedState: r.issuedState,
            issuedAt: r.issuedAt,
            expiresAt: r.expiresAt,
            standing: standingOf(r.status, r.expiresAt, now),
            verificationMethod: r.verificationMethod,
            recordedByEmail: r.recordedByUser?.email ?? null,
          })
        )
      ),
      stateLicenses: Object.freeze(
        provider.stateLicenses.map((l) =>
          Object.freeze({
            licenseId: l.id,
            state: l.state,
            licenseNumber: l.licenseNumber,
            licenseType: l.licenseType,
            issuedAt: l.issuedAt,
            expiresAt: l.expiresAt,
            standing: standingOf(l.status, l.expiresAt, now),
            verificationMethod: l.verificationMethod,
            recordedByEmail: l.recordedByUser?.email ?? null,
          })
        )
      ),
      activeClinics: Object.freeze(
        provider.clinicAffiliations.map((a) =>
          Object.freeze({ code: a.clinic.code, name: a.clinic.name })
        )
      ),
    });
  });
}
