// SignOffControl — a named human attests that a control is designed
// and operating.
//
// Why a human command at all, when probes already produce evidence:
// automated checks establish that the platform keeps VERIFYING a
// control. They cannot establish that anyone accountable looked at
// the result and stands behind it. SOC 2 asks for both, and an
// attestation nobody signed is not an attestation. This command is
// therefore deliberately unavailable to workers, schedulers, and any
// model-driven path — `COMPLIANCE_CONTROL_SIGN_OFF` is held by
// people.
//
// The guard that makes this more than a timestamp:
//
//   Sign-off is REFUSED when a probe linked to the control is
//   currently failing and no active exception covers it. Attesting
//   that a control operates while the platform's own evidence says
//   otherwise is the single most damaging thing an operator could do
//   here — it manufactures a signed claim contradicted by the run
//   history sitting next to it, which is worse for the audit than
//   leaving the control unsigned. The operator's route forward is to
//   fix the finding or accept a justified, time-boxed exception; both
//   are recorded.
//
// A tenant command, not a SystemCommand, for the reason
// RecordAccessReviewSnapshot documents: the tenant executor writes
// `command_log` PRE-transaction, so the handler can reference
// `commandLogId` immediately, and the attesting operator's identity
// and tenancy are exactly what belongs on the audit hop.
//
// Tenancy wrinkle, stated plainly: `compliance_control` is
// PLATFORM-level (schema.prisma §10) while the actor belongs to an
// organization. The attestation is therefore recorded in the
// attester's org audit chain, but the control it attests to is
// global. In the intended deployment the signer is the operator
// organization's security or compliance officer; the permission is
// what confines it, and it is not granted in the default tenant role
// templates.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

const inputSchema = z
  .object({
    /** Stable control identifier, e.g. "CC6.1-2". */
    controlCode: z.string().min(1).max(64),
    /**
     * Status being attested to. Required rather than defaulted: the
     * signer states what they believe the control's condition to be,
     * and "I signed off" without saying what was signed off is not
     * evidence.
     */
    status: z.enum(["IMPLEMENTED", "PARTIAL", "PLANNED", "DEPRECATED", "NOT_APPLICABLE"]),
    /** Note recorded alongside the signature. */
    attestationNote: z.string().min(1).max(4000).nullable().default(null),
  })
  .strict();

export type SignOffControlInput = z.infer<typeof inputSchema>;

export interface SignOffControlOutput {
  readonly controlId: string;
  readonly controlCode: string;
  readonly status: string;
  readonly signedOffAt: string;
  readonly signedOffByUserId: string;
  readonly linkedCheckCount: number;
  readonly passingCheckCount: number;
}

export const COMPLIANCE_CONTROL_NOT_FOUND = "COMPLIANCE_CONTROL_NOT_FOUND";
export const COMPLIANCE_CONTROL_HAS_FAILING_CHECKS = "COMPLIANCE_CONTROL_HAS_FAILING_CHECKS";

export const SignOffControl: Command<SignOffControlInput, SignOffControlOutput> = {
  name: "SignOffControl",
  inputSchema,
  permission: PERMISSIONS.COMPLIANCE_CONTROL_SIGN_OFF,
  // The attestation note is operator-authored prose about a control,
  // never patient data, and its content is the point of the record —
  // redacting it would gut the evidence.
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<SignOffControlOutput>> {
    const control = await tx.complianceControl.findUnique({
      where: { code: input.controlCode },
      select: {
        id: true,
        code: true,
        ownerRole: true,
        checks: {
          select: {
            check: {
              select: {
                id: true,
                code: true,
                lastOutcome: true,
                enabled: true,
                exceptions: {
                  where: {
                    revokedAt: null,
                    expiresAt: { gt: clock.now() },
                  },
                  select: { id: true },
                },
              },
            },
          },
        },
      },
    });

    if (control === null) {
      throw new errors.NotFoundError({
        code: COMPLIANCE_CONTROL_NOT_FOUND,
        message: `SignOffControl: no control with code "${input.controlCode}".`,
        metadata: { controlCode: input.controlCode },
      });
    }

    const linkedChecks = control.checks.map((link) => link.check);

    // A disabled check is excluded from the guard: an operator has
    // already made a deliberate decision about it, and the dashboard
    // shows it as disabled rather than passing. Blocking sign-off on
    // it would leave no way to attest to the control at all.
    const blocking = linkedChecks.filter(
      (check) =>
        check.enabled &&
        (check.lastOutcome === "FAIL" || check.lastOutcome === "ERROR") &&
        check.exceptions.length === 0
    );

    if (blocking.length > 0) {
      throw new errors.ConflictError({
        code: COMPLIANCE_CONTROL_HAS_FAILING_CHECKS,
        message:
          `SignOffControl: control ${control.code} cannot be attested while ` +
          `${blocking.length} linked check(s) are failing with no active exception: ` +
          `${blocking.map((c) => c.code).join(", ")}. Fix the finding or accept a ` +
          `time-boxed exception first.`,
        metadata: {
          controlCode: control.code,
          blockingCheckCodes: blocking.map((c) => c.code),
        },
      });
    }

    const now = clock.now();
    const passingCheckCount = linkedChecks.filter((c) => c.lastOutcome === "PASS").length;

    await tx.complianceControl.update({
      where: { id: control.id },
      data: {
        status: input.status,
        lastSignedOffAt: now,
        lastSignedOffByUserId: ctx.actor.userId,
      },
    });

    const output: SignOffControlOutput = {
      controlId: control.id,
      controlCode: control.code,
      status: input.status,
      signedOffAt: now.toISOString(),
      signedOffByUserId: ctx.actor.userId,
      linkedCheckCount: linkedChecks.length,
      passingCheckCount,
    };

    return {
      output,
      audit: {
        action: "compliance.control.signed_off",
        resourceType: "ComplianceControl",
        resourceId: control.id,
        metadata: {
          commandLogId,
          controlCode: control.code,
          status: input.status,
          ownerRole: control.ownerRole,
          linkedCheckCount: linkedChecks.length,
          passingCheckCount,
          attestationNote: input.attestationNote,
        },
      },
      outboxEvents: [
        {
          eventType: "compliance.control.signed_off.v1",
          aggregateType: "ComplianceControl",
          aggregateId: control.id,
          payload: {
            controlId: control.id,
            controlCode: control.code,
            organizationId: ctx.organizationId,
            status: input.status,
            ownerRole: control.ownerRole,
            signedOffByUserId: ctx.actor.userId,
            signedOffAt: now.toISOString(),
            attestationNote: input.attestationNote,
            linkedCheckCount: linkedChecks.length,
            passingCheckCount,
            commandLogId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
