// quoteShippingRates — PHI-access audit gating.
//
// The behavior pinned here is the one that matters for §164.312(b):
// quoting decrypts a patient's name and home address and hands them to
// a carrier's rating API, so the access must be on record BEFORE the
// address leaves the process — and if it cannot be recorded, the
// address must not leave at all.
//
// Quoting mutates nothing, which is exactly why this path ran
// unaudited: "read-only" reads as "nothing to log" right up until you
// notice the read is a disclosure to a third party. These tests exist
// so that reasoning cannot quietly return.
//
// CLEAN ROOM / PHI: synthetic values only.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000a1";
const OPERATOR_ID = "00000000-0000-4000-8000-0000000000b1";

const resolveContextMock = vi.hoisted(() => vi.fn());
const auditPatientViewMock = vi.hoisted(() => vi.fn());
const getRatesMock = vi.hoisted(() => vi.fn());
const resolveAdapterMock = vi.hoisted(() => vi.fn());

vi.mock("./resolve-purchase-context.js", () => ({
  resolvePurchaseContext: resolveContextMock,
}));

vi.mock("./audit-patient-view.js", () => ({
  auditPatientView: auditPatientViewMock,
}));

vi.mock("@pharmax/database", () => ({
  readInOrgScope: (_org: string, fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock("@pharmax/shipping", () => ({
  resolveShippingAdapter: resolveAdapterMock,
}));

vi.mock("../logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { quoteShippingRates, QUOTE_RATES_PHI_VIEW_AUDIT_FAILED } from "./quote-shipping-rates.js";

const RESOLVED_CONTEXT = Object.freeze({
  ok: true,
  context: Object.freeze({
    orderId: ORDER_ID,
    patientId: PATIENT_ID,
    fromAddress: {
      name: "Site",
      street1: "1 Way",
      city: "Town",
      state: "CA",
      postalCode: "90001",
      country: "US",
    },
    toAddress: {
      name: "Synthetic Patient",
      street1: "2 Road",
      city: "Town",
      state: "CA",
      postalCode: "90002",
      country: "US",
    },
    parcel: { lengthInches: 3, widthInches: 3, heightInches: 3, weightOunces: 8 },
    availableProviders: ["FEDEX"],
  }),
});

function callQuote() {
  return quoteShippingRates({
    organizationId: ORG_ID,
    orderId: ORDER_ID,
    operatorUserId: OPERATOR_ID,
    provider: "FEDEX" as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveContextMock.mockResolvedValue(RESOLVED_CONTEXT);
  resolveAdapterMock.mockResolvedValue({ adapter: { getRates: getRatesMock } });
  getRatesMock.mockResolvedValue([{ serviceLevel: "GROUND", amountCents: 900 }]);
  auditPatientViewMock.mockResolvedValue({ ok: true, output: {} });
});

describe("quoteShippingRates PHI-access audit", () => {
  it("records the PHI view against the resolved patient and order", async () => {
    await callQuote();

    expect(auditPatientViewMock).toHaveBeenCalledTimes(1);
    expect(auditPatientViewMock.mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORG_ID,
      operatorUserId: OPERATOR_ID,
      patientId: PATIENT_ID,
      orderId: ORDER_ID,
      surface: "SHIPPING_RATE_QUOTE",
    });
  });

  it("audits BEFORE the address reaches the carrier", async () => {
    const order: string[] = [];
    auditPatientViewMock.mockImplementation(async () => {
      order.push("audit");
      return { ok: true, output: {} };
    });
    getRatesMock.mockImplementation(async () => {
      order.push("carrier");
      return [];
    });

    await callQuote();

    expect(order).toEqual(["audit", "carrier"]);
  });

  it("does not call the carrier when the audit fails", async () => {
    auditPatientViewMock.mockResolvedValue({
      ok: false,
      code: "PATIENT_VIEW_AUDIT_FAILED",
      message: "boom",
    });

    const result = await callQuote();

    expect(getRatesMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(QUOTE_RATES_PHI_VIEW_AUDIT_FAILED);
    }
  });

  it("never puts address content in the refusal message", async () => {
    auditPatientViewMock.mockResolvedValue({
      ok: false,
      code: "PATIENT_VIEW_AUDIT_FAILED",
      message: "boom",
    });

    const result = await callQuote();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("Synthetic Patient");
      expect(result.message).not.toContain("2 Road");
    }
  });

  it("quotes normally once the access is on record", async () => {
    const result = await callQuote();

    expect(result.ok).toBe(true);
    expect(getRatesMock).toHaveBeenCalledTimes(1);
  });
});
