// resetPassword — thin orchestration around the ResetPassword command.
//
// The web route calls this with the emailed token + new password. It
// only enters the system-context frame the system command requires;
// all logic (token validation, policy, revocation) lives in the command.
// An invalid/expired/used token surfaces as RESET_TOKEN_INVALID.

import { executeSystemCommand } from "@pharmax/command-bus";
import { withSystemContext } from "@pharmax/tenancy";

import {
  ResetPassword,
  type ResetPasswordInput,
  type ResetPasswordOutput,
} from "./commands/reset-password.js";

const REASON = "auth:reset-password";

export async function resetPassword(input: ResetPasswordInput): Promise<ResetPasswordOutput> {
  return withSystemContext(REASON, () => executeSystemCommand(ResetPassword, input));
}
