// Rx number allocator tests.
//
// `CreatePrescription`'s own suite covers the happy path through the
// command. These tests cover the allocator's edges directly: the
// padding contract that keeps the series sortable, and the race that
// happens the first time two transcriptions arrive for a clinic that
// has never been allocated from.

import { describe, expect, it, vi } from "vitest";

import { Prisma } from "@pharmax/database";

import { allocateRxNumber, formatRxNumber, RX_NUMBER_PAD_WIDTH } from "./rx-number.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CLINIC_ID = "22222222-2222-4222-8222-222222222222";

function duplicateKeyError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("duplicate key", {
    code: "P2002",
    clientVersion: "test",
  });
}

describe("formatRxNumber", () => {
  it("zero-pads so lexicographic order matches numeric order", () => {
    // The column is TEXT. Without padding "10" sorts before "9" and
    // the Rx list renders out of sequence.
    expect(formatRxNumber(9) < formatRxNumber(10)).toBe(true);
    expect(formatRxNumber(1)).toBe("0000001");
    expect(formatRxNumber(1234567)).toBe("1234567");
  });

  it("grows past the pad width rather than wrapping", () => {
    expect(formatRxNumber(12345678)).toBe("12345678");
    expect(formatRxNumber(1).length).toBe(RX_NUMBER_PAD_WIDTH);
  });
});

describe("allocateRxNumber", () => {
  it("returns the incremented counter for the clinic", async () => {
    const upsert = vi.fn(async () => ({ lastValue: 128 }));
    const tx = { rxNumberSequence: { upsert } } as never;

    const rxNumber = await allocateRxNumber({
      tx,
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
    });

    expect(rxNumber).toBe("0000128");
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
    const tx = { rxNumberSequence: { upsert, update } } as never;

    const rxNumber = await allocateRxNumber({
      tx,
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
    });

    expect(rxNumber).toBe("0000002");
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0].data).toEqual({ lastValue: { increment: 1 } });
  });

  it("wraps any other failure as an internal error naming the clinic", async () => {
    const tx = {
      rxNumberSequence: {
        upsert: vi.fn(async () => {
          throw new Error("connection reset");
        }),
      },
    } as never;

    await expect(
      allocateRxNumber({ tx, organizationId: ORG_ID, clinicId: CLINIC_ID })
    ).rejects.toMatchObject({
      code: "RX_NUMBER_ALLOCATION_FAILED",
      metadata: { clinicId: CLINIC_ID },
    });
  });
});
