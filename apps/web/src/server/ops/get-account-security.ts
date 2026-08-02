// Account-security projection — drives `/ops/account/security`.
//
// The signed-in operator's own second-factor state: active TOTP
// enrollment, registered WebAuthn credentials, and how many unused
// recovery codes remain. Self-scoped (the page passes the session's
// own userId) — this is not an admin surface.
//
// PHI: none — authenticator metadata only.
// Tenancy: explicit `organizationId` + `userId` predicates on top of
// RLS scope.

import "server-only";

import { readInOrgScope } from "@pharmax/database";

export interface AccountSecurityCredential {
  readonly id: string;
  readonly label: string;
  readonly aaguid: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface AccountSecuritySummary {
  readonly totpEnrolled: boolean;
  readonly webAuthnCredentials: ReadonlyArray<AccountSecurityCredential>;
  readonly unusedRecoveryCodes: number;
}

export async function getAccountSecurity(options: {
  readonly organizationId: string;
  readonly userId: string;
}): Promise<AccountSecuritySummary> {
  return readInOrgScope(options.organizationId, async (tx) => {
    const [totp, credentials, recoveryCodes] = await Promise.all([
      tx.mfaEnrollment.findFirst({
        where: {
          organizationId: options.organizationId,
          userId: options.userId,
          disabledAt: null,
          verifiedAt: { not: null },
        },
        select: { id: true },
      }),
      tx.webAuthnCredential.findMany({
        where: {
          organizationId: options.organizationId,
          userId: options.userId,
          disabledAt: null,
        },
        select: { id: true, label: true, aaguid: true, createdAt: true, lastUsedAt: true },
        orderBy: { createdAt: "asc" },
      }),
      tx.recoveryCode.count({
        where: { organizationId: options.organizationId, userId: options.userId, usedAt: null },
      }),
    ]);

    return {
      totpEnrolled: totp !== null,
      webAuthnCredentials: credentials,
      unusedRecoveryCodes: recoveryCodes,
    };
  });
}
