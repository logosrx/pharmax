// Atomic claim-and-lease of the next SENT print job for this
// workstation.
//
// The claim is an UPDATE (not a plain SELECT): it stamps
// `agentLeasedUntil = now() + lease` in the same statement that
// selects the row FOR UPDATE SKIP LOCKED. Without the lease stamp,
// the row lock released at transaction end while the job stayed
// SENT — two agent processes polling the same workstation would
// both pick the job up on consecutive ticks and print DUPLICATE
// vial labels. With the stamp, a claimed job is invisible to other
// agents until the lease expires (agent crash recovery) or the job
// reaches a terminal status via ConfirmVialLabelPrint.

import { Prisma, type PrismaClient } from "@pharmax/database";

export interface ClaimedSentPrintJob {
  readonly id: string;
  readonly renderedZpl: string;
  readonly printerId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  /** Requesting command's persisted W3C trace context; null for pre-trace rows. */
  readonly traceparent: string | null;
}

type ClaimRow = {
  id: string;
  renderedZpl: string;
  printerId: string;
  orderId: string;
  orderLineId: string;
  traceparent: string | null;
};

/**
 * Lease window. Generous relative to the per-job work (a TCP send +
 * status check + confirm command, normally < 5s) so a healthy agent
 * never loses its lease mid-job; short enough that a crashed
 * agent's job is retried within a minute.
 */
export const PRINT_JOB_LEASE_MS = 60_000;

export async function claimNextSentPrintJob(
  client: PrismaClient,
  input: {
    organizationId: string;
    workstationId: string;
    leaseMs?: number;
  }
): Promise<ClaimedSentPrintJob | null> {
  const leaseMs = input.leaseMs ?? PRINT_JOB_LEASE_MS;

  const rows = await client.$queryRaw<ClaimRow[]>(Prisma.sql`
    UPDATE print_job
    SET    "agentLeasedUntil" = NOW() + (${leaseMs} || ' milliseconds')::interval
    WHERE  id IN (
      SELECT id
      FROM print_job
      WHERE "organizationId" = ${input.organizationId}::uuid
        AND "workstationId" = ${input.workstationId}::uuid
        AND status = 'SENT'
        AND ("agentLeasedUntil" IS NULL OR "agentLeasedUntil" <= NOW())
      ORDER BY "requestedAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "renderedZpl", "printerId", "orderId", "orderLineId", "traceparent"
  `);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    id: row.id,
    renderedZpl: row.renderedZpl,
    printerId: row.printerId,
    orderId: row.orderId,
    orderLineId: row.orderLineId,
    traceparent: row.traceparent,
  };
}
