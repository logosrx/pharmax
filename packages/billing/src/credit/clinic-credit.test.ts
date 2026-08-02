// Clinic-credit helper tests.
//
// Covers:
//   - insertClinicCreditEntry: happy insert, positive-amount guard,
//     P2002 convergence (created=false + winner's id), non-P2002
//     rethrow.
//   - computeClinicCreditBalanceCents: Σ GRANT − Σ APPLICATION per
//     (org, clinic, currency), null sums treated as zero.
//   - lockClinicForCredit: FOR UPDATE row hit vs. NotFound.
//   - clinicCreditRecordedOutboxEvent: payload shape matches the
//     `billing.clinic_credit.recorded.v1` schema fields.

import { describe, expect, it, vi } from "vitest";

import type { PrismaTxClient } from "@pharmax/command-bus";
import { ClinicCreditEntryKind, ClinicCreditSource, Prisma } from "@pharmax/database";

import {
  CLINIC_CREDIT_CLINIC_NOT_FOUND,
  type ClinicCreditEntryInput,
  clinicCreditRecordedOutboxEvent,
  computeClinicCreditBalanceCents,
  insertClinicCreditEntry,
  lockClinicForCredit,
} from "./clinic-credit.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const INVOICE_ID = "1111aaaa-1111-4111-8111-000000000001";

const entryInput = (overrides: Partial<ClinicCreditEntryInput> = {}): ClinicCreditEntryInput => ({
  organizationId: ORG_ID,
  clinicId: CLINIC_ID,
  kind: ClinicCreditEntryKind.GRANT,
  source: ClinicCreditSource.OVERPAYMENT,
  amountCents: 2500,
  currency: "usd",
  creditEventKey: "credit-grant:01TESTULID0000000000000000",
  occurredAt: new Date("2026-06-01T10:00:00.000Z"),
  ...overrides,
});

function fakeTx(overrides: {
  createError?: Error;
  existingEntryId?: string;
  grantedCents?: number | null;
  appliedCents?: number | null;
  lockedRows?: Array<{ id: string }>;
}): PrismaTxClient & { calls: Array<{ op: string; args: unknown }> } {
  const calls: Array<{ op: string; args: unknown }> = [];
  const tx = {
    calls,
    clinicCreditEntry: {
      create: vi.fn(async (args: unknown) => {
        calls.push({ op: "create", args });
        if (overrides.createError !== undefined) throw overrides.createError;
        return { id: (args as { data: { id: string } }).data.id };
      }),
      findUnique: vi.fn(async (args: unknown) => {
        calls.push({ op: "findUnique", args });
        return overrides.existingEntryId !== undefined ? { id: overrides.existingEntryId } : null;
      }),
      aggregate: vi.fn(async (args: { where: { kind: string } }) => {
        calls.push({ op: "aggregate", args });
        const sum =
          args.where.kind === ClinicCreditEntryKind.GRANT
            ? (overrides.grantedCents ?? null)
            : (overrides.appliedCents ?? null);
        return { _sum: { amountCents: sum } };
      }),
    },
    $queryRaw: vi.fn(async (...args: unknown[]) => {
      calls.push({ op: "$queryRaw", args });
      return overrides.lockedRows ?? [{ id: CLINIC_ID }];
    }),
  };
  return tx as unknown as PrismaTxClient & { calls: Array<{ op: string; args: unknown }> };
}

describe("insertClinicCreditEntry", () => {
  it("inserts the entry and returns created=true", async () => {
    const tx = fakeTx({});
    const result = await insertClinicCreditEntry(tx, entryInput());

    expect(result.created).toBe(true);
    const createCall = tx.calls.find((c) => c.op === "create");
    const data = (createCall!.args as { data: Record<string, unknown> }).data;
    expect(data["id"]).toBe(result.creditEntryId);
    expect(data["kind"]).toBe("GRANT");
    expect(data["source"]).toBe("OVERPAYMENT");
    expect(data["amountCents"]).toBe(2500);
    expect(data["creditEventKey"]).toBe("credit-grant:01TESTULID0000000000000000");
    // Optional application links default to explicit nulls.
    expect(data["appliedToInvoiceId"]).toBeNull();
    expect(data["appliedPaymentId"]).toBeNull();
  });

  it.each([0, -2500, 12.5])("rejects non-positive / non-integer amount %s", async (amount) => {
    const tx = fakeTx({});
    await expect(insertClinicCreditEntry(tx, entryInput({ amountCents: amount }))).rejects.toThrow(
      /positive integers/
    );
    expect(tx.calls).toHaveLength(0);
  });

  it("converges on the winner's entry on a P2002 race (created=false)", async () => {
    const tx = fakeTx({
      createError: new Prisma.PrismaClientKnownRequestError("unique violation", {
        code: "P2002",
        clientVersion: "7.8.0",
      }),
      existingEntryId: "credit-entry-winner-1",
    });

    const result = await insertClinicCreditEntry(tx, entryInput());
    expect(result).toEqual({ creditEntryId: "credit-entry-winner-1", created: false });
  });

  it("rethrows non-P2002 errors", async () => {
    const tx = fakeTx({ createError: new Error("connection reset") });
    await expect(insertClinicCreditEntry(tx, entryInput())).rejects.toThrow("connection reset");
  });
});

describe("computeClinicCreditBalanceCents", () => {
  it("returns Σ GRANT − Σ APPLICATION scoped to (org, clinic, currency)", async () => {
    const tx = fakeTx({ grantedCents: 10_000, appliedCents: 3_500 });
    const balance = await computeClinicCreditBalanceCents(tx, {
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      currency: "usd",
    });
    expect(balance).toBe(6_500);

    const aggregates = tx.calls.filter((c) => c.op === "aggregate");
    expect(aggregates).toHaveLength(2);
    for (const call of aggregates) {
      const where = (call.args as { where: Record<string, unknown> }).where;
      expect(where["organizationId"]).toBe(ORG_ID);
      expect(where["clinicId"]).toBe(CLINIC_ID);
      expect(where["currency"]).toBe("usd");
    }
  });

  it("treats null sums (no rows) as zero", async () => {
    const tx = fakeTx({ grantedCents: null, appliedCents: null });
    const balance = await computeClinicCreditBalanceCents(tx, {
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      currency: "usd",
    });
    expect(balance).toBe(0);
  });
});

describe("lockClinicForCredit", () => {
  it("returns the locked clinic id when the row exists", async () => {
    const tx = fakeTx({});
    const locked = await lockClinicForCredit(tx, {
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
    });
    expect(locked.clinicId).toBe(CLINIC_ID);
    expect(tx.calls.some((c) => c.op === "$queryRaw")).toBe(true);
  });

  it("throws NotFound when no row matches (missing or cross-org)", async () => {
    const tx = fakeTx({ lockedRows: [] });
    await expect(
      lockClinicForCredit(tx, { organizationId: ORG_ID, clinicId: CLINIC_ID })
    ).rejects.toMatchObject({ code: CLINIC_CREDIT_CLINIC_NOT_FOUND });
  });
});

describe("clinicCreditRecordedOutboxEvent", () => {
  it("builds the billing.clinic_credit.recorded.v1 draft from the entry", () => {
    // Built without a `source` — APPLICATION entries never carry one.
    const entry: ClinicCreditEntryInput = {
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      kind: ClinicCreditEntryKind.APPLICATION,
      amountCents: 1234,
      currency: "usd",
      creditEventKey: "credit-apply:01TESTULID0000000000000000",
      appliedToInvoiceId: INVOICE_ID,
      appliedPaymentId: "payment-1",
      occurredAt: new Date("2026-06-01T10:00:00.000Z"),
    };
    const draft = clinicCreditRecordedOutboxEvent({
      creditEntryId: "credit-entry-1",
      entry,
      balanceAfterCents: 766,
    });

    expect(draft.eventType).toBe("billing.clinic_credit.recorded.v1");
    expect(draft.aggregateType).toBe("Clinic");
    expect(draft.aggregateId).toBe(CLINIC_ID);
    expect(draft.payload).toEqual({
      organizationId: ORG_ID,
      clinicId: CLINIC_ID,
      creditEntryId: "credit-entry-1",
      kind: "APPLICATION",
      source: null,
      amountCents: 1234,
      currency: "usd",
      balanceAfterCents: 766,
      appliedToInvoiceId: INVOICE_ID,
      occurredAt: "2026-06-01T10:00:00.000Z",
    });
  });
});
