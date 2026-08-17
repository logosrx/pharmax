// findCompoundBatchIdByNumber — tenancy predicate + not-found.
//
// Batch numbers are minted per site and are NOT globally unique, so
// the organizationId predicate is what keeps one org's scan from
// resolving to another org's batch. Pinned here because the redirect
// this feeds sends the operator straight to the batch page.
//
// CLEAN ROOM / PHI: synthetic identifiers only; a batch carries no
// patient data.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const BATCH_ID = "00000000-0000-4000-8000-0000000000b1";
const BATCH_NUMBER = "PHX-T30-1-040327";

const prismaMock = vi.hoisted(() => ({ compoundBatch: { findFirst: vi.fn() } }));

vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn(prismaMock),
}));

import { findCompoundBatchIdByNumber } from "./find-compound-batch-by-number.js";

describe("findCompoundBatchIdByNumber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the batch id and scopes the lookup to the organization", async () => {
    prismaMock.compoundBatch.findFirst.mockResolvedValue({ id: BATCH_ID });

    const batchId = await findCompoundBatchIdByNumber({
      organizationId: ORG_ID,
      batchNumber: BATCH_NUMBER,
    });

    expect(batchId).toBe(BATCH_ID);
    expect(prismaMock.compoundBatch.findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, batchNumber: BATCH_NUMBER },
      select: { id: true },
    });
  });

  it("returns null when no batch in this org carries that number", async () => {
    prismaMock.compoundBatch.findFirst.mockResolvedValue(null);

    await expect(
      findCompoundBatchIdByNumber({ organizationId: ORG_ID, batchNumber: BATCH_NUMBER })
    ).resolves.toBeNull();
  });
});
