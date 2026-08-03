// The PV1 approval gate.
//
// Two refusals, two codes, and one read of the acknowledgement table.
//
// The acknowledgement lookup is scoped to (organization, order,
// approving pharmacist). Every part of that key is load-bearing:
//
//   - ORDER, because a judgement about this patient's regimen on this
//     prescription is not a judgement about a different order's.
//   - PHARMACIST, because an acknowledgement is a professional
//     judgement attached to a person. If pharmacist A's
//     acknowledgement satisfied pharmacist B's approval, the alert
//     would have been converted into a checkbox that someone else
//     already ticked — and B would sign a decision they never made.
//   - ORGANIZATION, belt-and-braces behind the Prisma tenancy
//     extension and RLS. An unscoped read here would let one tenant's
//     acknowledgement open another tenant's gate, which is the worst
//     shape a cross-tenant leak can take: not a disclosure, a
//     bypassed safety control.
//
// Note what the gate does NOT do: it never downgrades a HARD_STOP,
// and there is no input by which a caller could ask it to. The
// unoverridable tier is unreachable from the acknowledgement path by
// construction, not by convention — `AcknowledgePV1ScreeningFinding`
// refuses to record one, and this function checks hard stops before
// it looks at acknowledgements at all.

import {
  findingsRequiringAcknowledgement,
  hardStopFindings,
  type ScreeningEvaluation,
} from "@pharmax/clinical-screening";
import type { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

import { PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED, PV1_SCREENING_HARD_STOP } from "./errors.js";

export interface ApprovalGateInput {
  readonly tx: Prisma.TransactionClient;
  readonly organizationId: string;
  readonly orderId: string;
  /** The pharmacist whose acknowledgements count. */
  readonly pharmacistUserId: string;
  readonly evaluation: ScreeningEvaluation;
}

/**
 * Refuse the approval unless the screening result permits it.
 *
 * Order of checks is deliberate: hard stops first, so an order that
 * cannot pass at all reports that rather than a list of
 * acknowledgements the pharmacist would waste time recording before
 * meeting the wall.
 */
export async function assertScreeningPermitsApproval(input: ApprovalGateInput): Promise<void> {
  const blocking = hardStopFindings(input.evaluation);
  if (blocking.length > 0) {
    throw new errors.InvariantViolationError({
      code: PV1_SCREENING_HARD_STOP,
      message:
        "Clinical screening returned a finding that cannot be overridden; this prescription cannot pass PV1 as written.",
      metadata: {
        orderId: input.orderId,
        // Codes and fingerprints only — the same PHI posture as the
        // persisted rows. A finding's `reason` is safe to store but
        // an error message is a different surface (it reaches logs
        // and partner responses), so the console reads the detail
        // from `order_screening_finding` inside an authorized
        // session.
        findingCodes: blocking.map((f) => f.code),
        fingerprints: blocking.map((f) => f.fingerprint),
      },
    });
  }

  const required = findingsRequiringAcknowledgement(input.evaluation);
  if (required.length === 0) return;

  const requiredFingerprints = required.map((f) => f.fingerprint);
  const acknowledged = await input.tx.orderScreeningAcknowledgement.findMany({
    where: {
      organizationId: input.organizationId,
      orderId: input.orderId,
      pharmacistUserId: input.pharmacistUserId,
      fingerprint: { in: requiredFingerprints },
    },
    select: { fingerprint: true },
  });

  const settled = new Set(acknowledged.map((row) => row.fingerprint));
  const outstanding = required.filter((f) => !settled.has(f.fingerprint));
  if (outstanding.length === 0) return;

  throw new errors.InvariantViolationError({
    code: PV1_SCREENING_ACKNOWLEDGEMENT_REQUIRED,
    message:
      "Clinical screening returned findings that this pharmacist has not acknowledged. " +
      "Acknowledgements are per-pharmacist: a colleague's acknowledgement of the same finding does not satisfy the gate.",
    metadata: {
      orderId: input.orderId,
      pharmacistUserId: input.pharmacistUserId,
      outstandingFindingCodes: outstanding.map((f) => f.code),
      outstandingFingerprints: outstanding.map((f) => f.fingerprint),
    },
  });
}
