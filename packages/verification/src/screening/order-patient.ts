// Resolving the patient behind a locked order.
//
// The command bus's `SELECT … FOR UPDATE` deliberately pulls a narrow,
// non-PHI column list off the order row, and `patientId` is not on it.
// Screening needs it — the patient's other active prescriptions ARE
// the profile half of an interaction check — so it is read here, in
// one small function, rather than by widening the lock's projection
// for every command in the codebase.
//
// `patientId` never leaves the screening path: it is not written to a
// finding, not put in audit metadata, and not logged. It is a lookup
// key held for the duration of one transaction.

import type { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";

export const PV1_SCREENING_ORDER_PATIENT_MISSING = "PV1_SCREENING_ORDER_PATIENT_MISSING";

export async function loadPatientIdForOrder(input: {
  readonly tx: Prisma.TransactionClient;
  readonly organizationId: string;
  readonly orderId: string;
}): Promise<string> {
  const row = await input.tx.order.findFirst({
    where: { id: input.orderId, organizationId: input.organizationId },
    select: { patientId: true },
  });
  if (row === null) {
    // The row is already locked by the time this runs, so a miss here
    // means the tenancy scope disagrees with the lock — a bug, not a
    // user-facing condition.
    throw new errors.InternalError({
      code: PV1_SCREENING_ORDER_PATIENT_MISSING,
      message: "Locked order row could not be re-read for the active tenancy.",
      metadata: { orderId: input.orderId },
    });
  }
  return row.patientId;
}
