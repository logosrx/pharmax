// Focused unit coverage for the two emergency-escalation renderers —
// subject shape, detail rows in text and html, the computed
// breach-delta row (and its omission on unparseable timestamps),
// HTML escaping, and the PHI posture (order numbers and status
// codes only — never patient fields). No channel or SDK in scope
// by design.

import { describe, expect, it } from "vitest";

import {
  renderOrderSlaBreachEscalatedEmail,
  renderShipmentEscalatedEmail,
  type OrderSlaBreachEscalatedRenderInput,
  type ShipmentEscalatedRenderInput,
} from "./render-order-escalated-email.js";

function buildSlaInput(
  overrides?: Partial<OrderSlaBreachEscalatedRenderInput>
): OrderSlaBreachEscalatedRenderInput {
  return {
    orderExternalNumber: "RX-1001",
    slaDeadlineAtIso: "2026-08-01T10:00:00.000Z",
    breachedAtIso: "2026-08-01T10:05:00.000Z",
    ...overrides,
  };
}

function buildShipmentInput(
  overrides?: Partial<ShipmentEscalatedRenderInput>
): ShipmentEscalatedRenderInput {
  return {
    orderExternalNumber: "RX-1001",
    escalationReason: "DELIVERY_EXCEPTION",
    lastTrackingStatus: "RETURNED",
    ...overrides,
  };
}

describe("renderOrderSlaBreachEscalatedEmail — subject", () => {
  it("prefixes with [Pharmax emergency], the SLA BREACH badge, and the order number", () => {
    const rendered = renderOrderSlaBreachEscalatedEmail(buildSlaInput());
    expect(rendered.subject).toBe(
      "[Pharmax emergency] SLA BREACH · Order RX-1001 escalated to the emergency bucket"
    );
  });
});

describe("renderOrderSlaBreachEscalatedEmail — text part", () => {
  it("carries the order number, both timestamps, the breach delta, and the call to action", () => {
    const rendered = renderOrderSlaBreachEscalatedEmail(buildSlaInput());
    expect(rendered.text).toContain("Order: RX-1001");
    expect(rendered.text).toContain("SLA deadline: 2026-08-01T10:00:00.000Z");
    expect(rendered.text).toContain("Breached at: 2026-08-01T10:05:00.000Z");
    expect(rendered.text).toContain("Over deadline by: 5m");
    expect(rendered.text).toContain("Open the ops console emergency bucket to claim this order.");
  });

  it("formats a breach delta above one hour as hours and minutes", () => {
    const rendered = renderOrderSlaBreachEscalatedEmail(
      buildSlaInput({ breachedAtIso: "2026-08-01T12:30:00.000Z" })
    );
    expect(rendered.text).toContain("Over deadline by: 2h 30m");
  });

  it("omits the breach-delta row when a timestamp is unparseable, keeping the raw values", () => {
    const rendered = renderOrderSlaBreachEscalatedEmail(buildSlaInput({ slaDeadlineAtIso: "" }));
    expect(rendered.text).not.toContain("Over deadline by:");
    expect(rendered.text).toContain("Breached at: 2026-08-01T10:05:00.000Z");
  });

  it("omits the breach-delta row when the breach precedes the deadline", () => {
    const rendered = renderOrderSlaBreachEscalatedEmail(
      buildSlaInput({ breachedAtIso: "2026-08-01T09:00:00.000Z" })
    );
    expect(rendered.text).not.toContain("Over deadline by:");
  });
});

describe("renderOrderSlaBreachEscalatedEmail — html part", () => {
  it("embeds the badge, headline, detail rows, and call to action", () => {
    const rendered = renderOrderSlaBreachEscalatedEmail(buildSlaInput());
    expect(rendered.html).toContain(">SLA BREACH<");
    expect(rendered.html).toContain("Order RX-1001 escalated to the emergency bucket");
    expect(rendered.html).toContain("2026-08-01T10:00:00.000Z");
    expect(rendered.html).toContain("2026-08-01T10:05:00.000Z");
    expect(rendered.html).toContain("Open the ops console emergency bucket to claim this order.");
  });
});

describe("renderShipmentEscalatedEmail — subject", () => {
  it("prefixes with [Pharmax emergency], the SHIPMENT EXCEPTION badge, and the order number", () => {
    const rendered = renderShipmentEscalatedEmail(buildShipmentInput());
    expect(rendered.subject).toBe(
      "[Pharmax emergency] SHIPMENT EXCEPTION · Order RX-1001 escalated to the emergency bucket"
    );
  });
});

describe("renderShipmentEscalatedEmail — text part", () => {
  it("carries the order number, reason code, tracking status, and the call to action", () => {
    const rendered = renderShipmentEscalatedEmail(buildShipmentInput());
    expect(rendered.text).toContain("Order: RX-1001");
    expect(rendered.text).toContain("Escalation reason: DELIVERY_EXCEPTION");
    expect(rendered.text).toContain("Last tracking status: RETURNED");
    expect(rendered.text).toContain("Open the ops console emergency bucket to claim this order.");
  });
});

describe("renderShipmentEscalatedEmail — html part", () => {
  it("embeds the badge, headline, and detail rows", () => {
    const rendered = renderShipmentEscalatedEmail(buildShipmentInput());
    expect(rendered.html).toContain(">SHIPMENT EXCEPTION<");
    expect(rendered.html).toContain("Order RX-1001 escalated to the emergency bucket");
    expect(rendered.html).toContain("DELIVERY_EXCEPTION");
    expect(rendered.html).toContain("RETURNED");
  });

  it("HTML-escapes every detail value", () => {
    const rendered = renderShipmentEscalatedEmail(
      buildShipmentInput({
        orderExternalNumber: 'RX<script>"1001"</script>',
        escalationReason: "A&B <exception>",
      })
    );
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("RX&lt;script&gt;&quot;1001&quot;&lt;/script&gt;");
    expect(rendered.html).toContain("A&amp;B &lt;exception&gt;");
  });
});

describe("escalation renderers — PHI posture", () => {
  // House posture (matches the drain's context contract and the
  // registry's phiAllowed: false): order numbers, reason codes,
  // carrier statuses, and ISO timestamps only. The renderers have
  // no input slot for patient fields; pin that the rendered output
  // is exactly a function of the operational fields given.
  it("renders nothing beyond the operational fields provided", () => {
    const sla = renderOrderSlaBreachEscalatedEmail(buildSlaInput());
    const shipment = renderShipmentEscalatedEmail(buildShipmentInput());
    for (const part of [sla.text, sla.html, shipment.text, shipment.html]) {
      expect(part).not.toMatch(/patient/i);
      expect(part).not.toMatch(/date of birth|\bdob\b/i);
    }
  });
});
