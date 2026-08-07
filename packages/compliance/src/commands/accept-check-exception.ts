// AcceptCheckException — accept a failing check as a time-boxed,
// justified exception.
//
// This is the command that makes a red control stop being red without
// the underlying problem being fixed, which makes it the most
// dangerous surface in the compliance module. Every constraint below
// exists to keep it from becoming the quiet way to make the dashboard
// green:
//
//   - A reason code from a closed vocabulary, so exceptions are
//     countable by kind rather than being a pile of free text.
//   - A written justification. Someone reads this aloud in an audit.
//   - A hard expiry, capped. A permanent exception is not an
//     exception; it is an undocumented change to the control design,
//     and the correct action there is to amend the control.
//   - A named approver, with onDelete: Restrict on the FK, so the
//     person who accepted the risk cannot later be deleted out from
//     under the record.
//   - Its own permission, separate from control sign-off, so the
//     ability to silence a finding is granted deliberately.
//
// Renewal is deliberately NOT a feature. Extending an exception means
// accepting a new one, with a fresh justification and a fresh
// signature. An exception that can be renewed with one click becomes
// permanent by drift, which is exactly the failure the expiry exists
// to prevent — and the new row leaves the old one in place as
// evidence of how long the condition has really been tolerated.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

/**
 * Closed vocabulary for why a finding is being accepted.
 *
 * Kept small on purpose. Each value implies a different follow-up, and
 * a reviewer sorting exceptions by kind is the point:
 *
 *   COMPENSATING_CONTROL — something else covers the risk. The
 *     justification must say what.
 *   VENDOR_DEPENDENCY — blocked on a third party. Revisit when they
 *     ship.
 *   PLANNED_REMEDIATION — fix is scheduled; this covers the gap until
 *     it lands.
 *   ACCEPTED_RISK — the organization has decided to live with it.
 *     The most scrutinized value, and the one an auditor will ask
 *     about first.
 *   PROBE_DEFECT — the check itself is wrong. Distinct from the
 *     others because the remediation is to the probe, not the
 *     platform, and counting these separately keeps a broken probe
 *     from inflating the apparent risk-acceptance rate.
 */
export const COMPLIANCE_EXCEPTION_REASON_CODES = Object.freeze([
  "COMPENSATING_CONTROL",
  "VENDOR_DEPENDENCY",
  "PLANNED_REMEDIATION",
  "ACCEPTED_RISK",
  "PROBE_DEFECT",
] as const);

/**
 * Ceiling on a single exception window. A quarter is long enough to
 * carry a real remediation to completion and short enough that every
 * live exception is re-justified within one audit period.
 */
export const COMPLIANCE_EXCEPTION_MAX_DAYS = 90;

const inputSchema = z
  .object({
    /** Registry code of the check being excepted. */
    checkCode: z.string().min(1).max(200),
    /**
     * Narrow the exception to one tenant, or omit for platform-wide.
     * Independent of the approver's own organization.
     */
    subjectOrganizationId: z.uuid().nullable().default(null),
    reasonCode: z.enum(COMPLIANCE_EXCEPTION_REASON_CODES),
    /**
     * Minimum length is enforced rather than nominal: "n/a" is not a
     * justification, and a one-word entry defeats the only part of
     * this record a human actually reads.
     */
    justification: z.string().min(20).max(4000),
    /** Days until expiry. Bounded by COMPLIANCE_EXCEPTION_MAX_DAYS. */
    durationDays: z.int().min(1).max(COMPLIANCE_EXCEPTION_MAX_DAYS),
  })
  .strict();

export type AcceptCheckExceptionInput = z.infer<typeof inputSchema>;

export interface AcceptCheckExceptionOutput {
  readonly exceptionId: string;
  readonly checkId: string;
  readonly checkCode: string;
  readonly subjectOrganizationId: string | null;
  readonly reasonCode: string;
  readonly expiresAt: string;
  readonly approvedByUserId: string;
}

export const COMPLIANCE_CHECK_NOT_FOUND = "COMPLIANCE_CHECK_NOT_FOUND";
export const COMPLIANCE_EXCEPTION_ALREADY_ACTIVE = "COMPLIANCE_EXCEPTION_ALREADY_ACTIVE";

export const AcceptCheckException: Command<AcceptCheckExceptionInput, AcceptCheckExceptionOutput> =
  {
    name: "AcceptCheckException",
    inputSchema,
    permission: PERMISSIONS.COMPLIANCE_EXCEPTION_ACCEPT,
    // The justification is the evidence. Redacting it would leave a
    // record that a finding was silenced with no record of why.
    redactFields: [],

    async handle({
      input,
      ctx,
      tx,
      commandLogId,
      clock,
    }): Promise<HandlerResult<AcceptCheckExceptionOutput>> {
      const now = clock.now();

      const check = await tx.complianceCheck.findUnique({
        where: { code: input.checkCode },
        select: {
          id: true,
          code: true,
          severity: true,
          exceptions: {
            where: {
              revokedAt: null,
              expiresAt: { gt: now },
              subjectOrganizationId: input.subjectOrganizationId,
            },
            select: { id: true, expiresAt: true },
          },
        },
      });

      if (check === null) {
        throw new errors.NotFoundError({
          code: COMPLIANCE_CHECK_NOT_FOUND,
          message: `AcceptCheckException: no check with code "${input.checkCode}".`,
          metadata: { checkCode: input.checkCode },
        });
      }

      // Refusing a duplicate is what stops silent extension. Stacking a
      // second exception over a live one would move the effective expiry
      // without anyone revoking the first, which is renewal by another
      // name.
      const existing = check.exceptions[0];
      if (existing !== undefined) {
        throw new errors.ConflictError({
          code: COMPLIANCE_EXCEPTION_ALREADY_ACTIVE,
          message:
            `AcceptCheckException: check ${check.code} already has an active exception ` +
            `for this scope, expiring ${existing.expiresAt.toISOString()}. Revoke it ` +
            `before accepting a new one.`,
          metadata: {
            checkCode: check.code,
            existingExceptionId: existing.id,
            existingExpiresAt: existing.expiresAt.toISOString(),
          },
        });
      }

      const expiresAt = new Date(now.getTime() + input.durationDays * 86_400_000);

      const created = await tx.complianceCheckException.create({
        data: {
          checkId: check.id,
          subjectOrganizationId: input.subjectOrganizationId,
          reasonCode: input.reasonCode,
          justification: input.justification,
          approvedByUserId: ctx.actor.userId,
          expiresAt,
        },
        select: { id: true },
      });

      const output: AcceptCheckExceptionOutput = {
        exceptionId: created.id,
        checkId: check.id,
        checkCode: check.code,
        subjectOrganizationId: input.subjectOrganizationId,
        reasonCode: input.reasonCode,
        expiresAt: expiresAt.toISOString(),
        approvedByUserId: ctx.actor.userId,
      };

      return {
        output,
        audit: {
          action: "compliance.check_exception.accepted",
          resourceType: "ComplianceCheckException",
          resourceId: created.id,
          metadata: {
            commandLogId,
            checkCode: check.code,
            severity: check.severity,
            subjectOrganizationId: input.subjectOrganizationId,
            reasonCode: input.reasonCode,
            justification: input.justification,
            durationDays: input.durationDays,
            expiresAt: expiresAt.toISOString(),
          },
        },
        outboxEvents: [
          {
            eventType: "compliance.check_exception.accepted.v1",
            aggregateType: "ComplianceCheckException",
            aggregateId: created.id,
            payload: {
              exceptionId: created.id,
              checkId: check.id,
              checkCode: check.code,
              severity: check.severity,
              organizationId: ctx.organizationId,
              subjectOrganizationId: input.subjectOrganizationId,
              reasonCode: input.reasonCode,
              justification: input.justification,
              approvedByUserId: ctx.actor.userId,
              expiresAt: expiresAt.toISOString(),
              durationDays: input.durationDays,
              commandLogId,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    },
  };
