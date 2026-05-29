// registry-contract.test.ts — drain ↔ event-registry parity.
//
// What this file pins:
//
//   Every event name that the production outbox-handlers
//   registry routes is ALSO registered in `@pharmax/events`'s
//   `EVENT_REGISTRY`. Without this assertion a typo in the
//   handler key (or a registry removal) would route the event to
//   the default no-op path silently.
//
//   For each routed event, a synthetic happy-path payload (drawn
//   from the handler's own field-projection patterns in
//   `outbox-handlers.ts`, `escalate-on-shipment-exception.ts`,
//   `materialize-billing-on-order-shipped.ts`, and
//   `push-invoice-to-stripe.ts`) is validated against the
//   registered schema. If the handler reads a field the schema
//   does not declare, the schema is incomplete; if the schema
//   declares a field the handler does not read, that's an
//   acceptable forward-looking gap (the test only checks that
//   the handler's expected projection PASSES validation).
//
// This file does NOT modify any handler. It only exercises the
// registered schemas against the field-name projections the
// handlers read off `row.payload`.

import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, getEventDefinition, validateAgainst } from "@pharmax/events";

import { createOutboxHandlers } from "./outbox-handlers.js";

const ORG = "00000000-0000-4000-8000-000000000001";
const SITE = "00000000-0000-4000-8000-000000000002";
const CLINIC = "00000000-0000-4000-8000-000000000003";
const ORDER = "00000000-0000-4000-8000-000000000004";
const SHIPMENT = "00000000-0000-4000-8000-000000000005";
const TRACKING_EVENT = "00000000-0000-4000-8000-000000000006";
const BUCKET = "00000000-0000-4000-8000-000000000007";
const USER = "00000000-0000-4000-8000-000000000008";
const INVOICE = "00000000-0000-4000-8000-000000000009";
const INVOICE_LINE = "00000000-0000-4000-8000-00000000000a";
const PRINTER = "00000000-0000-4000-8000-00000000000b";
const PRINT_JOB = "00000000-0000-4000-8000-00000000000c";
const VIAL_LABEL = "00000000-0000-4000-8000-00000000000d";
const NOW = "2026-05-25T10:00:00.000Z";

// One synthetic payload per routed event. These mirror what the
// producer commands emit and what the handlers project out.
const PAYLOADS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  "organization.created.v1": {
    organizationId: ORG,
    slug: "acme",
    name: "Acme Pharmacy",
    adminUserId: USER,
    initialSiteId: SITE,
    occurredAt: NOW,
  },
  "labels.vial_print.requested.v1": {
    organizationId: ORG,
    orderId: ORDER,
    orderLineId: INVOICE_LINE, // reusing a uuid placeholder; shape only
    printJobId: PRINT_JOB,
    vialLabelId: VIAL_LABEL,
    printerId: PRINTER,
    workstationId: null,
    templateCode: "default.zebra-zd420",
    templateVersion: 1,
    contentHashHex: "a".repeat(64),
    occurredAt: NOW,
  },
  "labels.vial_print.reprint_requested.v1": {
    organizationId: ORG,
    orderId: ORDER,
    orderLineId: INVOICE_LINE,
    printJobId: PRINT_JOB,
    vialLabelId: VIAL_LABEL,
    reprintReasonCode: "LABEL_DAMAGED",
    printerId: PRINTER,
    workstationId: null,
    occurredAt: NOW,
  },
  "shipment.tracking.recorded.v1": {
    organizationId: ORG,
    shipmentId: SHIPMENT,
    orderId: ORDER,
    siteId: SITE,
    source: "EASYPOST",
    trackingEventId: TRACKING_EVENT,
    externalEventId: "evt_abc123",
    kind: "EXCEPTION",
    carrierStatus: "delivery_exception",
    occurredAt: NOW,
    cachedStatusAdvanced: true,
  },
  "order.shipped.v1": {
    orderId: ORDER,
    organizationId: ORG,
    clinicId: CLINIC,
    siteId: SITE,
    shipmentId: SHIPMENT,
    trackingNumber: "9405511899560000000000",
    shippingClerkUserId: USER,
    bucketId: BUCKET,
    transitionId: "wf.v1.confirm_shipment",
    fromState: "READY_TO_SHIP",
    toState: "SHIPPED",
    occurredAt: NOW,
  },
  "billing.invoice.finalized.v1": {
    organizationId: ORG,
    clinicId: CLINIC,
    invoiceId: INVOICE,
    invoiceNumber: "INV-2026-0001",
    currency: "usd",
    subtotalCents: 10000,
    totalCents: 10000,
    amountDueCents: 10000,
    lineCount: 1,
    issuedAt: NOW,
    dueAt: "2026-06-25T10:00:00.000Z",
    occurredAt: NOW,
  },
  "reporting.run.completed.v1": {
    organizationId: ORG,
    reportRunId: "00000000-0000-4000-8000-00000000000f",
    reportId: "order-volume-by-stage",
    reportVersion: 1,
    rowCount: 100,
    aggregates: { totalShipped: 100 },
    windowFrom: NOW,
    windowTo: "2026-05-28T00:00:00.000Z",
    generatedAt: NOW,
    runByUserId: USER,
    runViaScheduleId: "00000000-0000-4000-8000-000000000077",
  },
});

describe("outbox handler ↔ event registry parity", () => {
  it("every handler key resolves to a registered event definition", () => {
    const fake = createOutboxHandlers({
      // We never CALL any of these — we only enumerate the keys.
      // Cast to the runtime-narrow types the factory needs; the
      // factory does not dereference its deps at construction.
      client: {} as never,
      prisma: {} as never,
      stripePort: null,
    });
    const handlerKeys = Object.keys(fake).filter((k) => fake[k] !== undefined);
    for (const key of handlerKeys) {
      const def = getEventDefinition(key);
      expect(def, `handler "${key}" has no registered EventDefinition`).toBeDefined();
    }
  });

  it("every routed event has a synthetic payload that validates against its schema", () => {
    const fake = createOutboxHandlers({
      client: {} as never,
      prisma: {} as never,
      stripePort: null,
    });
    const handlerKeys = Object.keys(fake).filter((k) => fake[k] !== undefined);
    for (const key of handlerKeys) {
      const def = getEventDefinition(key);
      expect(def, `${key} is not registered`).toBeDefined();
      if (!def) continue;
      const payload = PAYLOADS[key];
      expect(payload, `no synthetic payload defined for "${key}"`).toBeDefined();
      if (!payload) continue;
      const result = validateAgainst(def, payload);
      if (!result.ok) {
        const issues = result.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new Error(`synthetic payload for "${key}" failed validation: ${issues}`);
      }
    }
  });

  it("payload aggregate-id selectors return the expected ids", () => {
    expect(
      EVENT_REGISTRY.get("order.shipped.v1")!.aggregateIdFrom(PAYLOADS["order.shipped.v1"]!)
    ).toBe(ORDER);
    expect(
      EVENT_REGISTRY.get("billing.invoice.finalized.v1")!.aggregateIdFrom(
        PAYLOADS["billing.invoice.finalized.v1"]!
      )
    ).toBe(INVOICE);
    expect(
      EVENT_REGISTRY.get("shipment.tracking.recorded.v1")!.aggregateIdFrom(
        PAYLOADS["shipment.tracking.recorded.v1"]!
      )
    ).toBe(SHIPMENT);
  });
});
