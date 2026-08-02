// Shared first-factor (email + password) verification used by the
// SignIn command and by StartWebAuthnAuthentication (ADR-0036) — the
// WebAuthn options endpoint is password-gated so credential ids are
// never enumerable without the first factor. One definition so the
// two paths can never drift on the enumeration-defense rules.
//
// Every failure throws the SAME generic INVALID_CREDENTIALS; the
// specific reason lives only in the error metadata for the
// login_attempt ledger.

import { UserStatus } from "@pharmax/database";

import { getAuthConfiguration } from "../configure.js";
import { invalidCredentialsError } from "../errors.js";

/** Minimal structural slice of the Prisma tx this helper needs. */
export interface FirstFactorTx {
  readonly user: {
    findUnique(args: {
      where: { organizationId_email: { organizationId: string; email: string } };
      select: { id: true; status: true; hashedPassword: true; mfaEnrolled: true };
    }): Promise<{
      id: string;
      status: UserStatus;
      hashedPassword: string | null;
      mfaEnrolled: boolean;
    } | null>;
  };
}

export interface VerifiedFirstFactor {
  readonly userId: string;
  readonly mfaEnrolled: boolean;
  /** Non-null — verified against the submitted password. */
  readonly hashedPassword: string;
}

export async function verifyFirstFactor(input: {
  readonly tx: FirstFactorTx;
  readonly organizationId: string;
  /** Already lowercased by the caller. */
  readonly email: string;
  readonly password: string;
}): Promise<VerifiedFirstFactor> {
  const config = getAuthConfiguration();

  const user = await input.tx.user.findUnique({
    where: {
      organizationId_email: { organizationId: input.organizationId, email: input.email },
    },
    select: { id: true, status: true, hashedPassword: true, mfaEnrolled: true },
  });

  if (user === null) {
    throw invalidCredentialsError("user_not_found");
  }
  if (user.status !== UserStatus.ACTIVE) {
    throw invalidCredentialsError("user_not_active");
  }
  if (user.hashedPassword === null) {
    // INVITED user who never set a password, or a system account.
    throw invalidCredentialsError("no_password_set");
  }

  const passwordOk = await config.hasher.verify(user.hashedPassword, input.password);
  if (!passwordOk) {
    throw invalidCredentialsError("bad_password");
  }

  return {
    userId: user.id,
    mfaEnrolled: user.mfaEnrolled,
    hashedPassword: user.hashedPassword,
  };
}
