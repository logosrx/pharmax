import { Prisma, type PrismaClient } from "@pharmax/database";

export interface ClaimedSentPrintJob {
  readonly id: string;
  readonly renderedZpl: string;
  readonly printerId: string;
  readonly orderId: string;
  readonly orderLineId: string;
}

type ClaimRow = {
  id: string;
  renderedZpl: string;
  printerId: string;
  orderId: string;
  orderLineId: string;
};

export async function claimNextSentPrintJob(
  client: PrismaClient,
  input: {
    organizationId: string;
    workstationId: string;
  }
): Promise<ClaimedSentPrintJob | null> {
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimRow[]>(Prisma.sql`
      SELECT
        id,
        "renderedZpl",
        "printerId",
        "orderId",
        "orderLineId"
      FROM print_job
      WHERE "organizationId" = ${input.organizationId}::uuid
        AND "workstationId" = ${input.workstationId}::uuid
        AND status = 'SENT'
      ORDER BY "requestedAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
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
    };
  });
}
