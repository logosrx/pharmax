// scanDestination — the gate follows the destination.
//
// The regression these exist for: the compound-label redirect was
// added to the order-detail page BELOW its `orders.read` /
// `patients.read` guards. The batch page that redirect targets is a
// non-PHI inventory surface gated on `inventory.read` alone, so an
// operator who could view compound batches but held no order or PHI
// grant was refused at the order guard and never reached the page the
// topbar scan exists to open.
//
// Guard ORDER inside a server component is not reachable from a unit
// test, which is why the decision lives in a pure function and why the
// cases below assert the grant each destination demands — including
// the ones it must NOT demand.
//
// CLEAN ROOM / PHI: every token below is a synthetic production
// identifier; no patient data is involved on any path here.

import { describe, expect, it } from "vitest";

import { PERMISSIONS, type PermissionCode } from "@pharmax/rbac";

import { scanDestination } from "./scan-destination.js";

const BATCH_BARCODE = "PXB:PXP-000042:PHX-T30-1-040327";
const UNIT_SERIAL = "PHX-T30-1-040327-11";
const BATCH_NUMBER = "PHX-T30-1-040327";
const ORDER_UUID = "00000000-0000-4000-8000-0000000000aa";
const EXTERNAL_ORDER_NUMBER = "RX-100042";

function grants(...codes: ReadonlyArray<PermissionCode>): ReadonlySet<PermissionCode> {
  return new Set(codes);
}

/** Reads compound batches; holds no order or PHI grant. */
const INVENTORY_ONLY = grants(PERMISSIONS.INVENTORY_READ, PERMISSIONS.INVENTORY_BATCH_RELEASE);
/** The default operator shape: orders + PHI + inventory. */
const FULL = grants(PERMISSIONS.ORDERS_READ, PERMISSIONS.PATIENTS_READ, PERMISSIONS.INVENTORY_READ);

describe("scanDestination — compound stock labels", () => {
  it("routes a batch barcode to compound stock on inventory.read alone", () => {
    const destination = scanDestination({ token: BATCH_BARCODE, permissions: INVENTORY_ONLY });
    expect(destination).toStrictEqual({ kind: "compound-stock", batchNumber: BATCH_NUMBER });
  });

  it("routes a bare unit serial to its batch on inventory.read alone", () => {
    const destination = scanDestination({ token: UNIT_SERIAL, permissions: INVENTORY_ONLY });
    expect(destination).toStrictEqual({ kind: "compound-stock", batchNumber: BATCH_NUMBER });
  });

  it("does NOT require orders.read or patients.read for a compound label", () => {
    // The bug: these grants gate a PHI order page, and a batch is
    // neither an order nor a patient. Demanding them here refuses the
    // scan to exactly the compounding/QA operators it is built for.
    for (const token of [BATCH_BARCODE, UNIT_SERIAL]) {
      expect(scanDestination({ token, permissions: grants(PERMISSIONS.INVENTORY_READ) }).kind).toBe(
        "compound-stock"
      );
    }
  });

  it("refuses a compound label without inventory.read, naming that grant", () => {
    const destination = scanDestination({
      token: BATCH_BARCODE,
      // Full order authority is not authority over inventory.
      permissions: grants(PERMISSIONS.ORDERS_READ, PERMISSIONS.PATIENTS_READ),
    });
    expect(destination).toStrictEqual({
      kind: "denied",
      surface: "compound-stock",
      grant: PERMISSIONS.INVENTORY_READ,
    });
  });

  it("normalizes a lowercase-configured scanner to the stored batch number", () => {
    const destination = scanDestination({
      token: "pxb:pxp-000042:phx-t30-1-040327",
      permissions: INVENTORY_ONLY,
    });
    expect(destination).toStrictEqual({ kind: "compound-stock", batchNumber: BATCH_NUMBER });
  });
});

describe("scanDestination — order tokens", () => {
  it.each([
    ["internal order id", ORDER_UUID],
    ["vial label barcode", `PX:${ORDER_UUID}`],
    ["external order number", EXTERNAL_ORDER_NUMBER],
  ])("routes a %s to the order surface", (_label, token) => {
    expect(scanDestination({ token, permissions: FULL })).toStrictEqual({ kind: "order" });
  });

  it("still refuses an order token without orders.read", () => {
    const destination = scanDestination({
      token: ORDER_UUID,
      permissions: grants(PERMISSIONS.INVENTORY_READ, PERMISSIONS.PATIENTS_READ),
    });
    expect(destination).toStrictEqual({
      kind: "denied",
      surface: "order",
      grant: PERMISSIONS.ORDERS_READ,
    });
  });

  it("still refuses an order token without patients.read — the page decrypts PHI", () => {
    const destination = scanDestination({
      token: ORDER_UUID,
      permissions: grants(PERMISSIONS.ORDERS_READ),
    });
    expect(destination).toStrictEqual({
      kind: "denied",
      surface: "order",
      grant: PERMISSIONS.PATIENTS_READ,
    });
  });

  it("names orders.read first when both order grants are missing", () => {
    // One grant per refusal: a guard that lists two things to ask for
    // gets one of them requested.
    const destination = scanDestination({ token: ORDER_UUID, permissions: grants() });
    expect(destination).toStrictEqual({
      kind: "denied",
      surface: "order",
      grant: PERMISSIONS.ORDERS_READ,
    });
  });

  it("treats an unrecognizable token as an order token, so the resolver reports not-found", () => {
    // Free text is a legitimate thing to type into a search bar; it
    // has to reach the order lookup to be told it matched nothing.
    expect(scanDestination({ token: "not a barcode!!", permissions: FULL })).toStrictEqual({
      kind: "order",
    });
  });
});
