// SetClinicStatus — deactivate, reactivate, or archive a client practice.
//
// ONE command with a target status rather than a Deactivate/Reactivate/
// Archive trio, following the `CompoundBatch` transition precedent:
// ClinicStatus has three members and a command per edge would multiply
// without expressing anything the (from, to) pair does not.
//
// Legal transitions:
//
//   ACTIVE    -> INACTIVE    deactivate; stops new intake
//   INACTIVE  -> ACTIVE      reactivate
//   INACTIVE  -> ARCHIVED    archive; terminal
//
// ACTIVE -> ARCHIVED is refused. Archiving is irreversible, so it
// requires passing through INACTIVE first — which is also the state in
// which anyone notices there are still orders in flight. ARCHIVED has
// no outbound edge at all.
//
// THE SIDE EFFECT THAT MAKES THIS SECURITY-RELEVANT. Deactivating a
// client revokes every provider-portal session still acting for it, in
// the same transaction. Without that, a prescriber who selected this
// client before it was switched off keeps a live, correctly-scoped
// session into a client the pharmacy has just closed — and the session
// row is the portal's whole authorization story, so nothing downstream
// would notice. The revocation reason is ADMIN_REVOKED rather than
// SCOPE_CHANGED: the prescriber did not choose this.
//
// Archiving additionally requires that no order for the client is still
// in flight. A client with work in progress is not a closed
// relationship, and archiving one would strand those orders under a
// record the product treats as historical.
//
// PHI: none. `reason` is operator-authored text about a business
// relationship and must not describe a patient — a reviewer-enforced
// constraint, capped in length here.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { AuthSessionRevokeReason, ClinicStatus, OrderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { ORDER_TERMINAL_STATES } from "@pharmax/workflow";
import { z } from "zod";

export const SET_CLINIC_STATUS_NOT_FOUND = "SET_CLINIC_STATUS_NOT_FOUND";
export const SET_CLINIC_STATUS_ILLEGAL_TRANSITION = "SET_CLINIC_STATUS_ILLEGAL_TRANSITION";
export const SET_CLINIC_STATUS_ALREADY_SET = "SET_CLINIC_STATUS_ALREADY_SET";
export const SET_CLINIC_STATUS_ORDERS_IN_FLIGHT = "SET_CLINIC_STATUS_ORDERS_IN_FLIGHT";

/**
 * Allowed target statuses per current status. Absent key or missing
 * member means the transition is refused. ARCHIVED is deliberately
 * absent as a key — it is terminal.
 */
const LEGAL_TRANSITIONS: Readonly<Record<ClinicStatus, ReadonlyArray<ClinicStatus>>> =
  Object.freeze({
    [ClinicStatus.ACTIVE]: Object.freeze([ClinicStatus.INACTIVE]),
    [ClinicStatus.INACTIVE]: Object.freeze([ClinicStatus.ACTIVE, ClinicStatus.ARCHIVED]),
    [ClinicStatus.ARCHIVED]: Object.freeze([]),
  });

// SHIPPED and CANCELLED, sourced from the workflow package so this list
// cannot drift from the state machine's own definition. Indexing
// `OrderStatus` by the workflow literal rather than casting is
// deliberate: if the workflow package ever declares a terminal state
// the Prisma enum does not have, this fails to compile instead of
// silently producing a status no order can be in.
const TERMINAL_ORDER_STATUSES: ReadonlyArray<OrderStatus> = ORDER_TERMINAL_STATES.map(
  (s) => OrderStatus[s]
);

const inputSchema = z
  .object({
    clinicId: z.uuid(),
    status: z.enum(ClinicStatus),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type SetClinicStatusInput = z.infer<typeof inputSchema>;

export interface SetClinicStatusOutput {
  readonly clinicId: string;
  readonly code: string;
  readonly fromStatus: ClinicStatus;
  readonly toStatus: ClinicStatus;
  readonly revokedPortalSessionCount: number;
}

export const SetClinicStatus: Command<SetClinicStatusInput, SetClinicStatusOutput> = {
  name: "SetClinicStatus",
  inputSchema,
  permission: PERMISSIONS.CLINICS_SET_STATUS,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<SetClinicStatusOutput>> {
    const clinic = await tx.clinic.findFirst({
      where: { id: input.clinicId, organizationId: ctx.organizationId },
      select: { id: true, code: true, status: true },
    });
    if (clinic === null) {
      throw new errors.NotFoundError({
        code: SET_CLINIC_STATUS_NOT_FOUND,
        message: "Client not found in this organization.",
        metadata: { clinicId: input.clinicId },
      });
    }

    const fromStatus = clinic.status;

    // A no-op is surfaced rather than silently succeeding: a caller who
    // believes they just deactivated a client, when it was already
    // inactive, has a different mental model from reality and the
    // audit trail would not show why nothing happened.
    if (fromStatus === input.status) {
      throw new errors.ValidationError({
        code: SET_CLINIC_STATUS_ALREADY_SET,
        message: `Client is already ${input.status}.`,
        metadata: { clinicId: clinic.id, status: fromStatus },
      });
    }

    const allowed = LEGAL_TRANSITIONS[fromStatus];
    if (!allowed.includes(input.status)) {
      throw new errors.ValidationError({
        code: SET_CLINIC_STATUS_ILLEGAL_TRANSITION,
        message:
          allowed.length === 0
            ? `Client is ${fromStatus}, which is terminal. No status change is possible.`
            : `Cannot move a client from ${fromStatus} to ${input.status}. Allowed: ${allowed.join(", ")}.`,
        metadata: {
          clinicId: clinic.id,
          fromStatus,
          toStatus: input.status,
          allowed: [...allowed],
        },
      });
    }

    if (input.status === ClinicStatus.ARCHIVED) {
      const inFlight = await tx.order.count({
        where: {
          organizationId: ctx.organizationId,
          clinicId: clinic.id,
          currentStatus: { notIn: [...TERMINAL_ORDER_STATUSES] },
        },
      });
      if (inFlight > 0) {
        throw new errors.ValidationError({
          code: SET_CLINIC_STATUS_ORDERS_IN_FLIGHT,
          message: `Cannot archive a client with ${inFlight} order(s) still in flight. Ship or cancel them first.`,
          metadata: { clinicId: clinic.id, inFlightOrderCount: inFlight },
        });
      }
    }

    const now = clock.now();

    await tx.clinic.update({
      where: { id: clinic.id },
      data: { status: input.status },
    });

    // Reactivation revokes nothing — there is no live session to close,
    // and signing prescribers out of a client that just came back is
    // the opposite of the intent.
    let revokedPortalSessionCount = 0;
    if (input.status !== ClinicStatus.ACTIVE) {
      const revoked = await tx.portalSession.updateMany({
        where: {
          organizationId: ctx.organizationId,
          activeClinicId: clinic.id,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
          revokedReason: AuthSessionRevokeReason.ADMIN_REVOKED,
        },
      });
      revokedPortalSessionCount = revoked.count;
    }

    return {
      output: Object.freeze({
        clinicId: clinic.id,
        code: clinic.code,
        fromStatus,
        toStatus: input.status,
        revokedPortalSessionCount,
      }),
      audit: {
        action: "org.clinic.status_changed",
        resourceType: "Clinic",
        resourceId: clinic.id,
        metadata: {
          code: clinic.code,
          fromStatus,
          toStatus: input.status,
          reason: input.reason,
          revokedPortalSessionCount,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.clinic.status_changed.v1",
          aggregateType: "Clinic",
          aggregateId: clinic.id,
          payload: {
            organizationId: ctx.organizationId,
            clinicId: clinic.id,
            code: clinic.code,
            fromStatus,
            toStatus: input.status,
            reason: input.reason,
            revokedPortalSessionCount,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
