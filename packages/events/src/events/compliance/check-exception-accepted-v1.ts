// compliance.check_exception.accepted.v1 — a failing check was
// accepted as a time-boxed, justified exception.
//
// Producer: `AcceptCheckException` (`@pharmax/compliance`).
//
// This is the most sensitive event in the compliance surface. It is
// the moment a red control stops being red without the underlying
// problem being fixed, and it is therefore the first thing a reviewer
// should be able to enumerate: who silenced what, on what grounds,
// and until when. Emitting it as its own event means that list is a
// query over the outbox and the audit chain rather than an
// after-the-fact reconstruction from row timestamps.
//
// Consumers (current):
//   - Nightly security digest: enumerates exceptions accepted in the
//     last 24h and any expiring within the week, so an exception
//     cannot quietly become permanent by renewal drift.
//
// Consumers (future):
//   - SOC 2 evidence pack (exception register per period).
//   - Alert when an exception is accepted on a CRITICAL check.
//
// Tenancy: the exception row is PLATFORM-level (schema.prisma §10);
// `organizationId` identifies the APPROVER's tenancy for outbox and
// audit-chain purposes. `subjectOrganizationId` — when set — is the
// tenant the exception is scoped to, and the two are independent.
//
// PHI invariant: check codes, reason codes, an operator-authored
// justification, and operator uuids. No patient data.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    exceptionId: z.uuid(),
    checkId: z.uuid(),
    /** Stable probe identifier, e.g. "identity.mfa.elevated_role_enrollment". */
    checkCode: z.string().min(1).max(200),
    /** Severity of the check being excepted. Present so a consumer can
     *  alert on CRITICAL without a second lookup. */
    severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
    /** Approver's tenancy, for outbox + audit-chain anchoring. */
    organizationId: z.uuid(),
    /** Tenant the exception is narrowed to, or null for platform-wide.
     *  Independent of `organizationId`. */
    subjectOrganizationId: z.uuid().nullable(),
    /** Controlled vocabulary — see COMPLIANCE_EXCEPTION_REASON_CODES. */
    reasonCode: z.string().min(1).max(64),
    /** Written rationale. Read aloud in the audit. */
    justification: z.string().min(1).max(4000),
    approvedByUserId: z.uuid(),
    /** Hard stop. Never null: a permanent exception is an
     *  undocumented change to the control design, not an exception. */
    expiresAt: z.iso.datetime({ offset: true }),
    /** Whole days from acceptance to expiry, so a reviewer can spot an
     *  unusually long window without doing date arithmetic. */
    durationDays: z.int().min(1),
    /** Audit chain hop: exception → this commandLog. */
    commandLogId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ComplianceCheckExceptionAcceptedV1 = defineEvent({
  name: "compliance.check_exception.accepted",
  version: 1,
  aggregateType: "ComplianceCheckException",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.exceptionId,
  owner: "security",
  retention: "7y",
  phiSafe: true,
  routingKey: "tenant.compliance",
  description:
    "Emitted by AcceptCheckException when a failing check is accepted as a time-boxed exception. The audit-visible record of who silenced which finding, on what grounds, and until when.",
});

export type ComplianceCheckExceptionAcceptedV1Payload = z.infer<typeof payloadSchema>;
