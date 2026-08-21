// SwitchPortalClinic — choose, or change, the client practice a portal
// session acts for.
//
// REVOKE AND RE-MINT, never edit in place. The old session is revoked
// with SCOPE_CHANGED and a new token issued. Editing `activeClinicId`
// on the live row would be less code and worse in two specific ways:
//
//   - An in-flight request could observe the scope changing underneath
//     it, having already decided what it was allowed to read.
//   - "What scope did this request run under" would stop being
//     answerable from its session id, and would instead require
//     replaying every switch event in order. One token, one client, for
//     the token's whole life keeps that reconstruction trivial — which
//     is the property an auditor asks for.
//
// The candidate clinic arrives from a form post, so it is
// caller-controlled until `canActForClinic` proves it against the
// roster. That check is the whole security content of this command: the
// session row is the portal's only trustworthy scope, and this is the
// one place it is written.
//
// A SYSTEM command for the same reason PortalSignIn is one: portal
// principals have no tenancy frame, and the session row supplies the
// organization.

import { getAuthConfiguration } from "@pharmax/auth";
import type { SystemCommand, SystemHandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { z } from "zod";

import { canActForClinic } from "./clinic-access.js";
import { createPortalSessionInTx } from "./session.js";

export const SWITCH_PORTAL_CLINIC_SESSION_NOT_FOUND = "SWITCH_PORTAL_CLINIC_SESSION_NOT_FOUND";
export const SWITCH_PORTAL_CLINIC_NOT_AFFILIATED = "SWITCH_PORTAL_CLINIC_NOT_AFFILIATED";

const inputSchema = z
  .object({
    /** The session doing the switching, resolved from its cookie. */
    sessionId: z.uuid(),
    organizationId: z.uuid(),
    portalAccountId: z.uuid(),
    providerId: z.uuid(),
    /** Caller-controlled until proven against the roster. */
    clinicId: z.uuid(),
    ipAddress: z.string().max(64).optional(),
    userAgent: z.string().max(512).optional(),
  })
  .strict();

export type SwitchPortalClinicInput = z.infer<typeof inputSchema>;

export interface SwitchPortalClinicOutput {
  readonly sessionId: string;
  /** Bearer token for the new, single-client-scoped session. */
  readonly rawToken: string;
  readonly clinicId: string;
  readonly previousSessionId: string;
  readonly previousClinicId: string | null;
}

export const SwitchPortalClinic: SystemCommand<SwitchPortalClinicInput, SwitchPortalClinicOutput> =
  {
    name: "SwitchPortalClinic",
    inputSchema,
    redactFields: ["rawToken"],

    async handle({
      input,
      tx,
      commandLogId,
      clock,
    }): Promise<SystemHandlerResult<SwitchPortalClinicOutput>> {
      const config = getAuthConfiguration();
      const now = clock.now();

      // The current session must still be live and must belong to the
      // account claiming it. Without the portalAccountId predicate a
      // stolen session id would be enough to re-scope somebody else's
      // session.
      const current = await tx.portalSession.findFirst({
        where: {
          id: input.sessionId,
          organizationId: input.organizationId,
          portalAccountId: input.portalAccountId,
          revokedAt: null,
        },
        select: { id: true, activeClinicId: true },
      });
      if (current === null) {
        throw new errors.NotFoundError({
          code: SWITCH_PORTAL_CLINIC_SESSION_NOT_FOUND,
          message: "Your session is no longer valid. Sign in again.",
          metadata: { sessionId: input.sessionId },
        });
      }

      const allowed = await canActForClinic({
        tx,
        organizationId: input.organizationId,
        providerId: input.providerId,
        clinicId: input.clinicId,
      });
      if (!allowed) {
        throw new errors.AuthorizationError({
          code: SWITCH_PORTAL_CLINIC_NOT_AFFILIATED,
          message: "You are not currently associated with that client practice.",
          metadata: { clinicId: input.clinicId },
        });
      }

      await tx.portalSession.update({
        where: { id: current.id },
        data: { revokedAt: now, revokedReason: "SCOPE_CHANGED" },
      });

      const session = await createPortalSessionInTx({
        tx,
        portalAccountId: input.portalAccountId,
        organizationId: input.organizationId,
        activeClinicId: input.clinicId,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        config,
      });

      return {
        output: {
          sessionId: session.sessionId,
          rawToken: session.rawToken,
          clinicId: input.clinicId,
          previousSessionId: current.id,
          previousClinicId: current.activeClinicId,
        },
        targetOrganizationId: input.organizationId,
        audit: {
          action: "portal_session.client_switched",
          resourceType: "PortalAccount",
          resourceId: input.portalAccountId,
          metadata: {
            commandLogId,
            providerId: input.providerId,
            fromSessionId: current.id,
            fromClinicId: current.activeClinicId,
            toSessionId: session.sessionId,
            toClinicId: input.clinicId,
          },
        },
        outboxEvents: [
          {
            eventType: "provider.portal_session.client_switched.v1",
            aggregateType: "PortalAccount",
            aggregateId: input.portalAccountId,
            payload: {
              organizationId: input.organizationId,
              portalAccountId: input.portalAccountId,
              providerId: input.providerId,
              fromSessionId: current.id,
              fromClinicId: current.activeClinicId,
              toSessionId: session.sessionId,
              toClinicId: input.clinicId,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    },
  };
