// Batch number → internal batch id, for scan dispatch.
//
// A scanned compound label carries the printed batch number, not the
// row id the batch page is addressed by. This is the one lookup that
// bridges them; `scan-destination.ts` decides whether the operator may
// make it, and this runs only after that gate.
//
// Kept to the id alone on purpose. The destination page loads the
// batch it renders (and re-checks `inventory.read` doing so), so
// widening this into a projection would only pre-load rows the
// redirect throws away.
//
// PHI: none — a batch number is a production identifier with no
// patient on it. Tenancy: explicit organizationId predicate on top of
// RLS.

import "server-only";

import { readInOrgScope } from "@pharmax/database";

/** `null` when no batch in this org carries that number. */
export async function findCompoundBatchIdByNumber(input: {
  readonly organizationId: string;
  readonly batchNumber: string;
}): Promise<string | null> {
  const batch = await readInOrgScope(input.organizationId, (tx) =>
    tx.compoundBatch.findFirst({
      where: { organizationId: input.organizationId, batchNumber: input.batchNumber },
      select: { id: true },
    })
  );
  return batch === null ? null : batch.id;
}
