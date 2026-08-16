// Invite orchestration — thin system-context wrappers around the
// IssueInvite / AcceptInvite commands.
//
// `issueInvite` is called by the admin invite route AFTER orgs
// `InviteUser` creates the INVITED row; it returns the raw setup token
// so the route can build the accept-invite URL (and hand it to the
// mailer port or surface it to the admin). `acceptInvite` is called by
// the public accept-invite route with the token + new password, and
// screens that password against the breach corpus BEFORE dispatching —
// the bus opens the transaction before the handler runs, so this is the
// last place that network call can happen without a connection held
// open across it.
//
// Because that screen runs before the handler resolves the token, the
// burst gate has to run before the screen: otherwise an unauthenticated
// caller buys one corpus lookup per request. See
// ./credential-setup-limit.ts for the keying and the reason a refusal
// here is the same opaque error as an unknown token.

import { executeSystemCommand } from "@pharmax/command-bus";
import { withSystemContext } from "@pharmax/tenancy";

import {
  AcceptInvite,
  type AcceptInviteInput,
  type AcceptInviteOutput,
} from "./commands/accept-invite.js";
import {
  IssueInvite,
  type IssueInviteInput,
  type IssueInviteOutput,
} from "./commands/issue-invite.js";
import {
  guardCredentialSetupBurst,
  type CredentialSetupBurstInput,
} from "./credential-setup-limit.js";
import { withScreenedPassword } from "./password/breach-screen.js";

/**
 * `AcceptInviteInput` plus the transport fact the burst gate needs.
 * `ipAddress` is NOT part of the command input: it would land in
 * `command_log.requestPayload` as a caller-asserted value, and the
 * command has no use for it.
 */
export type AcceptInviteRequest = AcceptInviteInput & CredentialSetupBurstInput;

export async function issueInvite(input: IssueInviteInput): Promise<IssueInviteOutput> {
  return withSystemContext("auth:issue-invite", () => executeSystemCommand(IssueInvite, input));
}

export async function acceptInvite(input: AcceptInviteRequest): Promise<AcceptInviteOutput> {
  const { ipAddress, ...command } = input;
  await guardCredentialSetupBurst({ ipAddress });
  return withScreenedPassword(command.newPassword, () =>
    withSystemContext("auth:accept-invite", () => executeSystemCommand(AcceptInvite, command))
  );
}
