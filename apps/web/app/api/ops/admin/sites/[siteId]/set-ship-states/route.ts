// POST /api/ops/admin/sites/[siteId]/set-ship-states
//
// Declare which states a pharmacy site may dispense into — go-live G-2.
// MFA-gated, and of everything in this PR it is the action most worth
// gating: the set it writes is the only thing preventing a prescription
// shipping into a state the pharmacy holds no licence for.
//
// DECLARATIVE. The form posts the complete resulting set as repeated
// checkbox values, matching the command. An add/remove endpoint would
// let two operators each apply their own increment without noticing the
// other; a full-set write makes the last writer's intent unambiguous.
//
// An empty submission is legal and withdraws every authorization, which
// also switches enforcement OFF for the site. The form confirms that
// explicitly rather than treating it as a no-op.

import { SetSiteAuthorizedShipStates } from "@pharmax/orgs";

import { dispatchOpsCommandWithMfa } from "@/server/auth/dispatch-ops-with-mfa";
import { readStringField, readStringListField } from "@/server/ops/read-body-field";

interface RouteParams {
  readonly params: Promise<{ readonly siteId: string }>;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { siteId } = await context.params;
  return await dispatchOpsCommandWithMfa({
    request,
    command: SetSiteAuthorizedShipStates,
    idempotencyKeyPrefix: `route:set-ship-states:${siteId}:${Date.now()}`,
    buildInput: ({ body }) => {
      const reason = readStringField(body, "reason");
      if (reason === null) return { error: "A reason is required." };
      // States are read as free text, not against an enum: the command
      // is the authority on which ones have a live licence behind them,
      // and it refuses the rest with a specific message.
      //
      // No emptiness guard — an empty set is a meaningful instruction
      // that withdraws every authorization.
      return { siteId, states: [...readStringListField(body, "states")], reason };
    },
    successRedirect: (output) => {
      const parts: string[] = [];
      if (output.addedStates.length > 0) parts.push(`added ${output.addedStates.join(", ")}`);
      if (output.removedStates.length > 0) parts.push(`removed ${output.removedStates.join(", ")}`);
      const summary = parts.length === 0 ? "No change to the licensed states." : parts.join("; ");
      // The activation transition is the part an operator most needs
      // told: refusals begin now.
      const activated = output.enforcementActivated
        ? " Ship-to-state enforcement is now ACTIVE for this site."
        : "";
      const deactivated =
        output.states.length === 0 && output.removedStates.length > 0
          ? " Ship-to-state enforcement is now OFF for this site."
          : "";
      return `/ops/admin/sites/${siteId}?flash=${encodeURIComponent(
        `${summary}.${activated}${deactivated}`
      )}`;
    },
    failureRedirect: `/ops/admin/sites/${siteId}`,
    successLogEvent: "ops.admin.site.set_ship_states.applied",
    failureLogEvent: "ops.admin.site.set_ship_states.failed",
  });
}
