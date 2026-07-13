// MFA floor for privileged operator roles (ADR-0030).
//
// HIPAA § 164.308(a)(5)(ii)(D) and SOC 2 CC6.1 expect a second factor
// for accounts that can access/modify PHI or financial data. Pharmax
// enforces this for two role codes:
//
//   - `OrgAdmin`       — full administrative reach over the org.
//   - `BillingManager` — invoice + pricing administration.
//
// Under the in-house engine, MFA is verified at SIGN-IN (the SignIn
// command runs the TOTP/recovery step for enrolled users), and the
// result is recorded on the session as `mfaSatisfied`. So the write-time
// floor is a pure, in-process check — no identity-provider round-trip:
// if the operator holds a floor role, the session MUST be mfaSatisfied.
//
// The canonical floor set lives in @pharmax/auth; we re-export it here
// so existing call sites keep importing from the web auth folder.

import "server-only";

import { MFA_REQUIRED_ROLE_CODES } from "@pharmax/auth";
import { errors } from "@pharmax/platform-core";

export { MFA_REQUIRED_ROLE_CODES };

export const MFA_REQUIRED = "MFA_REQUIRED" as const;

export type MfaGateOutcome =
  | { readonly status: "mfa_not_required" }
  | { readonly status: "mfa_satisfied" }
  | {
      readonly status: "mfa_required_not_satisfied";
      readonly enforcingRoleCodes: ReadonlyArray<string>;
    };

/**
 * Pure evaluation of the MFA floor for an operator. `mfaSatisfied` comes
 * from the resolved session (`resolveOperatorTenancyContext().operator`).
 */
export function evaluateOperatorMfa(input: {
  readonly roleCodes: ReadonlyArray<string>;
  readonly mfaSatisfied: boolean;
}): MfaGateOutcome {
  const enforcing = input.roleCodes.filter((c) => MFA_REQUIRED_ROLE_CODES.has(c));
  if (enforcing.length === 0) {
    return Object.freeze({ status: "mfa_not_required" } as const);
  }
  if (input.mfaSatisfied) {
    return Object.freeze({ status: "mfa_satisfied" } as const);
  }
  return Object.freeze({
    status: "mfa_required_not_satisfied",
    enforcingRoleCodes: Object.freeze([...enforcing]),
  } as const);
}

export class MfaRequiredError extends errors.AuthorizationError {
  public readonly enforcingRoleCodes: ReadonlyArray<string>;

  public constructor(detail: {
    readonly userId: string;
    readonly enforcingRoleCodes: ReadonlyArray<string>;
  }) {
    super({
      code: MFA_REQUIRED,
      message:
        "Multi-factor authentication is required for this action. Re-authenticate with your second factor and retry.",
      metadata: { userId: detail.userId, enforcingRoleCodes: [...detail.enforcingRoleCodes] },
    });
    this.enforcingRoleCodes = Object.freeze([...detail.enforcingRoleCodes]);
  }
}

/**
 * Throw-on-denial wrapper. Use BEFORE dispatching a privileged write
 * (billing, admin). Throws `MFA_REQUIRED` (403) when a floor role holds
 * but the session has not cleared MFA.
 */
export function enforceOperatorMfa(input: {
  readonly userId: string;
  readonly roleCodes: ReadonlyArray<string>;
  readonly mfaSatisfied: boolean;
}): void {
  const outcome = evaluateOperatorMfa(input);
  switch (outcome.status) {
    case "mfa_not_required":
    case "mfa_satisfied":
      return;
    case "mfa_required_not_satisfied":
      throw new MfaRequiredError({
        userId: input.userId,
        enforcingRoleCodes: outcome.enforcingRoleCodes,
      });
    default: {
      const _exhaustive: never = outcome;
      void _exhaustive;
      throw new Error("enforceOperatorMfa: unreachable");
    }
  }
}
