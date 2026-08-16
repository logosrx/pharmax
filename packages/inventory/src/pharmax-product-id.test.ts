// Pharmax Product ID allocator tests.
//
// `CreateCompoundProduct`'s own suite covers the happy path through
// the command. These tests cover the allocator's edges directly: the
// prefix + padding contract that keeps the PXP series sortable, and
// the race that happens the first time two creations arrive for an
// org that has never minted a compound.

import { describe, expect, it, vi } from "vitest";

import { Prisma } from "@pharmax/database";

import {
  allocatePharmaxProductId,
  formatPharmaxProductId,
  PHARMAX_PRODUCT_ID_PAD_WIDTH,
  PHARMAX_PRODUCT_ID_PREFIX,
} from "./pharmax-product-id.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function duplicateKeyError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("duplicate key", {
    code: "P2002",
    clientVersion: "test",
  });
}

describe("formatPharmaxProductId", () => {
  it("zero-pads so lexicographic order matches numeric order", () => {
    // The column is TEXT. Without padding "PXP-10" sorts before
    // "PXP-9" and the catalog renders out of sequence.
    expect(formatPharmaxProductId(9) < formatPharmaxProductId(10)).toBe(true);
    expect(formatPharmaxProductId(1)).toBe("PXP-000001");
    expect(formatPharmaxProductId(123456)).toBe("PXP-123456");
  });

  it("grows past the pad width rather than wrapping", () => {
    expect(formatPharmaxProductId(1234567)).toBe("PXP-1234567");
    expect(formatPharmaxProductId(1).length).toBe(
      PHARMAX_PRODUCT_ID_PREFIX.length + PHARMAX_PRODUCT_ID_PAD_WIDTH
    );
  });
});

describe("allocatePharmaxProductId", () => {
  it("returns the incremented counter for the org", async () => {
    const upsert = vi.fn(async () => ({ lastValue: 42 }));
    const tx = { pharmaxProductIdSequence: { upsert } } as never;

    const id = await allocatePharmaxProductId({ tx, organizationId: ORG_ID });

    expect(id).toBe("PXP-000042");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("retries as a plain update when two callers race to create the counter row", async () => {
    // Prisma falls back to a non-atomic find-then-write for some
    // upsert shapes; the loser of that race sees P2002 against a row
    // that now demonstrably exists.
    const upsert = vi.fn(async () => {
      throw duplicateKeyError();
    });
    const update = vi.fn(async (_args: { data: unknown }) => ({ lastValue: 2 }));
    const tx = { pharmaxProductIdSequence: { upsert, update } } as never;

    const id = await allocatePharmaxProductId({ tx, organizationId: ORG_ID });

    expect(id).toBe("PXP-000002");
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0].data).toEqual({ lastValue: { increment: 1 } });
  });

  it("wraps any other failure as an internal error naming the org", async () => {
    const tx = {
      pharmaxProductIdSequence: {
        upsert: vi.fn(async () => {
          throw new Error("connection reset");
        }),
      },
    } as never;

    await expect(allocatePharmaxProductId({ tx, organizationId: ORG_ID })).rejects.toMatchObject({
      code: "PHARMAX_PRODUCT_ID_ALLOCATION_FAILED",
      metadata: { organizationId: ORG_ID },
    });
  });
});
