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
import { withScreenedPassword } from "./password/breach-screen.js";

export async function issueInvite(input: IssueInviteInput): Promise<IssueInviteOutput> {
  return withSystemContext("auth:issue-invite", () => executeSystemCommand(IssueInvite, input));
}

export async function acceptInvite(input: AcceptInviteInput): Promise<AcceptInviteOutput> {
  return withScreenedPassword(input.newPassword, () =>
    withSystemContext("auth:accept-invite", () => executeSystemCommand(AcceptInvite, input))
  );
}
