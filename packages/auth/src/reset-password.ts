// resetPassword — thin orchestration around the ResetPassword command.
//
// The web route calls this with the emailed token + new password. It
// enters the two frames the command needs and nothing else; all logic
// (token validation, policy, revocation) lives in the command. An
// invalid/expired/used token, or a user who is not ACTIVE, surfaces as
// RESET_TOKEN_INVALID.
//
// `withScreenedPassword` is OUTSIDE the command dispatch on purpose:
// the breach check is a third-party network call and the bus opens the
// database transaction before the handler runs, so this is the last
// place it can happen without holding a connection open across it.
//
// The burst gate is outside THAT, for the reason R-026 records: the
// screen runs before the token is resolved, so a public route with no
// limit bills one corpus lookup per unauthenticated request. This function
// has no HTTP route yet; the gate lives here rather than in the route
// that will eventually call it precisely so it cannot be forgotten at
// that point. See ./credential-setup-limit.ts.

import { executeSystemCommand } from "@pharmax/command-bus";
import { withSystemContext } from "@pharmax/tenancy";

import {
  ResetPassword,
  type ResetPasswordInput,
  type ResetPasswordOutput,
} from "./commands/reset-password.js";
import {
  guardCredentialSetupBurst,
  type CredentialSetupBurstInput,
} from "./credential-setup-limit.js";
import { withScreenedPassword } from "./password/breach-screen.js";

const REASON = "auth:reset-password";

/** `ResetPasswordInput` plus the transport fact the burst gate needs. */
export type ResetPasswordRequest = ResetPasswordInput & CredentialSetupBurstInput;

export async function resetPassword(input: ResetPasswordRequest): Promise<ResetPasswordOutput> {
  const { ipAddress, ...command } = input;
  await guardCredentialSetupBurst({ ipAddress });
  return withScreenedPassword(command.newPassword, () =>
    withSystemContext(REASON, () => executeSystemCommand(ResetPassword, command))
  );
}
