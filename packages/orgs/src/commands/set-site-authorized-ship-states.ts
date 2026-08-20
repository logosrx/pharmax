// SetSiteAuthorizedShipStates — declare which states a pharmacy site
// may dispense into. Go-live G-2.
//
// This command writes the most consequential configuration in the
// platform. The set it stores is the only thing preventing a
// prescription shipping into a state the pharmacy holds no licence for,
// and that is a finding against the customer's licence rather than a
// software bug.
//
// DECLARATIVE, NOT INCREMENTAL. The input is the complete resulting
// set, and the command computes the delta. An add/remove pair would be
// less code here and worse everywhere else: two operators editing
// concurrently would each apply their own increment and neither would
// notice the other, whereas a full-set write makes the last writer's
// intent unambiguous and the audit row a complete statement of what is
// now true.
//
// EVERY STATE MUST CITE A LICENCE. Each authorization points at the
// STATE_PHARMACY_LICENSE that permits it, so "why may we ship to
// Oregon" has an answer an inspector can follow. A state with no
// matching live licence is refused — an authorization with nothing
// behind it is exactly the assertion this table exists to prevent
// anyone making.
//
// ENFORCEMENT IS PER-SITE AND SELF-GATING. A site with an empty set has
// asserted nothing, so nothing is enforced against it; declaring the
// first state is what turns enforcement on. That makes the rollout a
// tenant-by-tenant decision rather than a flag someone has to remember
// to flip, and it means shipping this command cannot break an existing
// tenant. `enforcementActivated` in the event marks that transition,
// because a tenant discovering it from a refused shipment is a support
// call.
//
// PHI: none.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { CredentialStatus, SiteCredentialKind } from "@pharmax/database";
import { errors, geo } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const SET_SHIP_STATES_SITE_NOT_FOUND = "SET_SHIP_STATES_SITE_NOT_FOUND";
export const SET_SHIP_STATES_UNKNOWN_STATE = "SET_SHIP_STATES_UNKNOWN_STATE";
export const SET_SHIP_STATES_NO_LICENSE = "SET_SHIP_STATES_NO_LICENSE";
export const SET_SHIP_STATES_DUPLICATE_STATE = "SET_SHIP_STATES_DUPLICATE_STATE";

const inputSchema = z
  .object({
    siteId: z.uuid(),
    /**
     * The COMPLETE resulting set. An empty array is legal and means
     * "withdraw every authorization", which also switches enforcement
     * off for this site — see the header.
     */
    states: z.array(z.string().length(2)).max(60),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type SetSiteAuthorizedShipStatesInput = z.infer<typeof inputSchema>;

export interface SetSiteAuthorizedShipStatesOutput {
  readonly siteId: string;
  readonly siteCode: string;
  readonly states: ReadonlyArray<string>;
  readonly addedStates: ReadonlyArray<string>;
  readonly removedStates: ReadonlyArray<string>;
  readonly enforcementActivated: boolean;
}

export const SetSiteAuthorizedShipStates: Command<
  SetSiteAuthorizedShipStatesInput,
  SetSiteAuthorizedShipStatesOutput
> = {
  name: "SetSiteAuthorizedShipStates",
  inputSchema,
  permission: PERMISSIONS.ORG_SHIP_STATES_MANAGE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<SetSiteAuthorizedShipStatesOutput>> {
    const normalized: string[] = [];
    for (const raw of input.states) {
      const code = geo.normalizeJurisdictionCode(raw);
      if (code === null) {
        throw new errors.ValidationError({
          code: SET_SHIP_STATES_UNKNOWN_STATE,
          message: `"${raw}" is not a US state or territory code.`,
          issues: [{ path: ["states"], message: `unknown jurisdiction: ${raw}` }],
        });
      }
      normalized.push(code);
    }

    const desired = new Set(normalized);
    if (desired.size !== normalized.length) {
      // Ambiguous rather than harmless: a repeated state means the
      // caller built the list from two sources and one of them is
      // probably stale.
      throw new errors.ValidationError({
        code: SET_SHIP_STATES_DUPLICATE_STATE,
        message: "The same state appears more than once.",
        issues: [{ path: ["states"], message: "duplicate entries" }],
      });
    }

    const site = await tx.pharmacySite.findFirst({
      where: { id: input.siteId, organizationId: ctx.organizationId },
      select: { id: true, code: true },
    });
    if (site === null) {
      throw new errors.NotFoundError({
        code: SET_SHIP_STATES_SITE_NOT_FOUND,
        message: "Pharmacy site not found in this organization.",
        metadata: { siteId: input.siteId },
      });
    }

    // Live state licences held by this site. `expiresAt: null` counts as
    // live — not recorded is a gap to close, not a lapse to enforce,
    // consistent with the prescriber credential models. A recorded past
    // date does not count, so a lapsed licence cannot keep authorizing
    // shipments.
    const now = clock.now();
    const licenses = await tx.siteCredential.findMany({
      where: {
        organizationId: ctx.organizationId,
        siteId: site.id,
        kind: SiteCredentialKind.STATE_PHARMACY_LICENSE,
        status: CredentialStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
      },
      select: { id: true, state: true },
    });
    const licenseByState = new Map<string, string>();
    for (const license of licenses) {
      if (license.state !== null) licenseByState.set(license.state, license.id);
    }

    const unlicensed = [...desired].filter((s) => !licenseByState.has(s)).sort();
    if (unlicensed.length > 0) {
      throw new errors.ValidationError({
        code: SET_SHIP_STATES_NO_LICENSE,
        message: `No current pharmacy licence on file for: ${unlicensed.join(", ")}. Record the licence before authorizing shipments there.`,
        metadata: { siteId: site.id, unlicensedStates: unlicensed },
      });
    }

    const existing = await tx.siteAuthorizedShipState.findMany({
      where: { organizationId: ctx.organizationId, siteId: site.id },
      select: { id: true, state: true },
    });
    const existingStates = new Set(existing.map((r) => r.state));

    const addedStates = [...desired].filter((s) => !existingStates.has(s)).sort();
    const removedStates = [...existingStates].filter((s) => !desired.has(s)).sort();

    if (removedStates.length > 0) {
      await tx.siteAuthorizedShipState.deleteMany({
        where: {
          organizationId: ctx.organizationId,
          siteId: site.id,
          state: { in: removedStates },
        },
      });
    }
    for (const state of addedStates) {
      await tx.siteAuthorizedShipState.create({
        data: {
          organizationId: ctx.organizationId,
          siteId: site.id,
          state,
          licenseCredentialId: licenseByState.get(state)!,
          authorizedByUserId: ctx.actor.userId,
        },
      });
    }

    const states = [...desired].sort();
    // The transition that matters: a site going from asserting nothing
    // to asserting something is the moment refusals begin.
    const enforcementActivated = existingStates.size === 0 && states.length > 0;

    return {
      output: Object.freeze({
        siteId: site.id,
        siteCode: site.code,
        states: Object.freeze(states),
        addedStates: Object.freeze(addedStates),
        removedStates: Object.freeze(removedStates),
        enforcementActivated,
      }),
      audit: {
        action: "org.site_ship_states.changed",
        resourceType: "PharmacySite",
        resourceId: site.id,
        metadata: {
          siteCode: site.code,
          states,
          addedStates,
          removedStates,
          enforcementActivated,
          reason: input.reason,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.site_ship_states.changed.v1",
          aggregateType: "PharmacySite",
          aggregateId: site.id,
          payload: {
            organizationId: ctx.organizationId,
            siteId: site.id,
            siteCode: site.code,
            states,
            addedStates,
            removedStates,
            enforcementActivated,
            reason: input.reason,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
