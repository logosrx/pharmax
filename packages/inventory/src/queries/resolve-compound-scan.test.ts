// Tests for the compound scan resolver.
//
// The resolver answers two questions at once — what did I scan, and may
// I dispense it — so the blocker logic is the substance here. Notably a
// RELEASED batch that has since passed its Beyond-Use Date must be
// blocked: status alone would clear it, which is exactly the case a
// status-only check misses.

import { describe, expect, it, vi } from "vitest";

import {
  resolveCompoundScan,
  SCAN_BLOCKER_BATCH_NOT_RELEASED,
  SCAN_BLOCKER_BATCH_REJECTED,
  SCAN_BLOCKER_PAST_BUD,
} from "./resolve-compound-scan.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2027-05-01T12:00:00.000Z");

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    batchNumber: "PHX-T30-1-040327",
    status: "DISPENSING",
    beyondUseDate: new Date("2027-07-02T00:00:00.000Z"),
    unitCount: 40,
    siteId: "22222222-2222-4222-8222-222222222222",
    site: { code: "PHX" },
    product: {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Tirzepatide/Glycine",
      strength: "10mg/20mg/3mL",
      pharmaxProductId: "PXP-000042",
    },
    ...overrides,
  };
}

function fakeTx(opts: {
  unit?: Record<string, unknown> | null;
  batch?: Record<string, unknown> | null;
}) {
  return {
    compoundBatchUnit: {
      findFirst: vi.fn(async () => opts.unit ?? null),
    },
    compoundBatch: {
      findFirst: vi.fn(async () => (opts.batch === undefined ? batchRow() : opts.batch)),
    },
  } as unknown as Parameters<typeof resolveCompoundScan>[0]["tx"];
}

describe("resolveCompoundScan — unit serial", () => {
  it("resolves a unit to its batch, product, and site with no blockers when dispensable", async () => {
    const tx = fakeTx({
      unit: {
        id: "aaaaaaaa-0000-4000-8000-000000000011",
        unitNumber: 11,
        serialNumber: "PHX-T30-1-040327-11",
        batch: batchRow(),
      },
    });

    const out = await resolveCompoundScan({
      tx,
      organizationId: ORG_ID,
      scan: { kind: "COMPOUND_UNIT", serialNumber: "PHX-T30-1-040327-11" },
      now: NOW,
    });

    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      batchNumber: "PHX-T30-1-040327",
      unitNumber: 11,
      serialNumber: "PHX-T30-1-040327-11",
      productName: "Tirzepatide/Glycine",
      pharmaxProductId: "PXP-000042",
      siteCode: "PHX",
    });
    expect(out?.blockers).toEqual([]);
  });

  it("returns null for an unknown serial rather than throwing", async () => {
    const tx = fakeTx({ unit: null });
    const out = await resolveCompoundScan({
      tx,
      organizationId: ORG_ID,
      scan: { kind: "COMPOUND_UNIT", serialNumber: "PHX-T30-1-040327-99" },
      now: NOW,
    });
    expect(out).toBeNull();
  });
});

describe("resolveCompoundScan — batch barcode", () => {
  it("resolves a batch with no unit fields set", async () => {
    const tx = fakeTx({ batch: batchRow() });
    const out = await resolveCompoundScan({
      tx,
      organizationId: ORG_ID,
      scan: { kind: "COMPOUND_BATCH", batchNumber: "PHX-T30-1-040327" },
      now: NOW,
    });

    expect(out?.batchNumber).toBe("PHX-T30-1-040327");
    expect(out?.unitId).toBeNull();
    expect(out?.unitNumber).toBeNull();
    expect(out?.serialNumber).toBeNull();
    expect(out?.blockers).toEqual([]);
  });

  it("returns null for an unknown batch number", async () => {
    const tx = fakeTx({ batch: null });
    const out = await resolveCompoundScan({
      tx,
      organizationId: ORG_ID,
      scan: { kind: "COMPOUND_BATCH", batchNumber: "PHX-T30-9-010199" },
      now: NOW,
    });
    expect(out).toBeNull();
  });
});

describe("resolveCompoundScan — dispensability", () => {
  it("clears a RELEASED batch", async () => {
    const tx = fakeTx({ batch: batchRow({ status: "RELEASED" }) });
    const out = await resolveCompoundScan({
      tx,
      organizationId: ORG_ID,
      scan: { kind: "COMPOUND_BATCH", batchNumber: "PHX-T30-1-040327" },
      now: NOW,
    });
    expect(out?.blockers).toEqual([]);
  });

  it("blocks a REJECTED batch", async () => {
    const tx = fakeTx({ batch: batchRow({ status: "REJECTED" }) });
    const out = await resolveCompoundScan({
      tx,
      organizationId: ORG_ID,
      scan: { kind: "COMPOUND_BATCH", batchNumber: "PHX-T30-1-040327" },
      now: NOW,
    });
    expect(out?.blockers).toEqual([SCAN_BLOCKER_BATCH_REJECTED]);
  });

  it("blocks a batch still on the bench or at the lab, distinctly from rejection", async () => {
    for (const status of ["COMPOUNDED", "TESTING"]) {
      const tx = fakeTx({ batch: batchRow({ status }) });
      const out = await resolveCompoundScan({
        tx,
        organizationId: ORG_ID,
        scan: { kind: "COMPOUND_BATCH", batchNumber: "PHX-T30-1-040327" },
        now: NOW,
      });
      // Reported separately from REJECTED because the remedies differ:
      // this batch may still be released, a rejected one never will be.
      expect(out?.blockers).toEqual([SCAN_BLOCKER_BATCH_NOT_RELEASED]);
    }
  });

  it("blocks a RELEASED batch that has passed its Beyond-Use Date", async () => {
    const tx = fakeTx({
      batch: batchRow({
        status: "RELEASED",
        beyondUseDate: new Date("2027-04-30T00:00:00.000Z"),
      }),
    });
    const out = await resolveCompoundScan({
      tx,
      organizationId: ORG_ID,
      scan: { kind: "COMPOUND_BATCH", batchNumber: "PHX-T30-1-040327" },
      now: NOW,
    });
    // Status alone would have cleared this.
    expect(out?.blockers).toEqual([SCAN_BLOCKER_PAST_BUD]);
  });

  it("clears a batch whose BUD is today — the BUD day is still dispensable", async () => {
    const tx = fakeTx({
      batch: batchRow({
        status: "DISPENSING",
        beyondUseDate: new Date("2027-05-01T00:00:00.000Z"),
      }),
    });
    const out = await resolveCompoundScan({
      tx,
      organizationId: ORG_ID,
      scan: { kind: "COMPOUND_BATCH", batchNumber: "PHX-T30-1-040327" },
      now: NOW,
    });
    expect(out?.blockers).toEqual([]);
  });

  it("reports both blockers when a batch is unreleased AND past its BUD", async () => {
    const tx = fakeTx({
      batch: batchRow({
        status: "TESTING",
        beyondUseDate: new Date("2027-04-01T00:00:00.000Z"),
      }),
    });
    const out = await resolveCompoundScan({
      tx,
      organizationId: ORG_ID,
      scan: { kind: "COMPOUND_BATCH", batchNumber: "PHX-T30-1-040327" },
      now: NOW,
    });
    expect(out?.blockers).toEqual([SCAN_BLOCKER_BATCH_NOT_RELEASED, SCAN_BLOCKER_PAST_BUD]);
  });
});
