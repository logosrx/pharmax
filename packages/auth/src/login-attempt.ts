// Login-attempt ledger + lockout counter.
//
// Why this is NOT written inside the SignIn command's transaction:
// a FAILED sign-in throws, which rolls the command tx back — so an
// attempt row written there would vanish exactly when we most need it.
// This ledger is written in its OWN committed transaction, so success
// AND failure both persist. It is the SOC 2 / HIPAA §164.312(b) record
// of authentication activity and the substrate for distributed lockout
// (no in-memory counters — the eonpro anti-pattern).
//
// `login_attempt` is platform-level (RLS-exempt): a failed attempt for
// an unknown email has no resolvable org. Writes run in a system-context
// frame so the `pharmax_system` role is selected. PHI-free by design —
// `emailAttempted` is an operator identifier.

import { LoginOutcome, prisma, type PrismaClient } from "@pharmax/database";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

import { getAuthConfiguration, type AuthConfiguration } from "./configure.js";

const RECORD_REASON = "auth:record-login-attempt";
const COUNT_REASON = "auth:count-login-failures";

type TxCapableClient = Pick<PrismaClient, "$transaction">;

export interface RecordLoginAttemptInput {
  readonly emailAttempted: string;
  readonly outcome: LoginOutcome;
  readonly organizationId?: string | null;
  readonly reasonCode?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly client?: TxCapableClient;
}

/** Append an attempt row in its own committed transaction. */
export async function recordLoginAttempt(input: RecordLoginAttemptInput): Promise<void> {
  const client = input.client ?? prisma;
  await withSystemContext(RECORD_REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, RECORD_REASON);
      await tx.loginAttempt.create({
        data: {
          emailAttempted: input.emailAttempted.toLowerCase(),
          outcome: input.outcome,
          organizationId: input.organizationId ?? null,
          reasonCode: input.reasonCode ?? null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
      });
    })
  );
}

/**
 * Count non-success attempts for an email within the lockout window.
 * The SignIn orchestration calls this BEFORE verifying a password so a
 * locked account never reaches the KDF (also blunts KDF-based DoS).
 */
export async function countRecentFailedAttempts(input: {
  readonly emailAttempted: string;
  readonly client?: TxCapableClient;
  readonly config?: AuthConfiguration;
}): Promise<number> {
  const config = input.config ?? getAuthConfiguration();
  const client = input.client ?? prisma;
  const since = new Date(config.clock.now().getTime() - config.lockout.windowMs);

  return withSystemContext(COUNT_REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, COUNT_REASON);
      return tx.loginAttempt.count({
        where: {
          emailAttempted: input.emailAttempted.toLowerCase(),
          // Only genuine failures count toward lockout. MFA_REQUIRED is
          // an intermediate step (the user still owes a code), not a
          // failed credential, so it must NOT lock the account.
          outcome: { in: [LoginOutcome.INVALID_CREDENTIALS, LoginOutcome.MFA_FAILED] },
          createdAt: { gte: since },
        },
      });
    })
  );
}

/** True when the email is currently locked out (failures ≥ policy max). */
export async function isLockedOut(input: {
  readonly emailAttempted: string;
  readonly client?: TxCapableClient;
  readonly config?: AuthConfiguration;
}): Promise<boolean> {
  const config = input.config ?? getAuthConfiguration();
  const failures = await countRecentFailedAttempts(input);
  return failures >= config.lockout.maxFailures;
}
