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

import { executeSystemCommand } from "@pharmax/command-bus";
import { withSystemContext } from "@pharmax/tenancy";

import {
  ResetPassword,
  type ResetPasswordInput,
  type ResetPasswordOutput,
} from "./commands/reset-password.js";
import { withScreenedPassword } from "./password/breach-screen.js";

const REASON = "auth:reset-password";

export async function resetPassword(input: ResetPasswordInput): Promise<ResetPasswordOutput> {
  return withScreenedPassword(input.newPassword, () =>
    withSystemContext(REASON, () => executeSystemCommand(ResetPassword, input))
  );
}
