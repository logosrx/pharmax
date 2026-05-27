// Behavioural tests for the in-memory adapter. The adapter is the
// reference implementation of `NotificationChannel`; every guard a
// production adapter is expected to run is exercised here.

import { describe, expect, it } from "vitest";

import { InMemoryNotificationChannel } from "./in-memory-notification-channel.js";

const validInvoiceContext = {
  invoiceNumber: "INV-0001",
  amountDueCents: 12_500,
  clinicName: "Pharmax Demo Clinic",
};

const validHoldContext = {
  orderExternalNumber: "ORD-EXT-42",
  holdReason: "MISSING_PRIOR_AUTHORIZATION",
  heldAt: "2026-05-25T20:00:00Z",
  heldByUserName: "Test Operator",
};

describe("InMemoryNotificationChannel — happy path", () => {
  it("records a delivered send with a fresh deliveryId", async () => {
    const channel = new InMemoryNotificationChannel();

    const result = await channel.send({
      to: { kind: "email", address: "ops@example.test" },
      template: "INVOICE_PAYMENT_FAILED_V1",
      context: validInvoiceContext,
      idempotencyKey: "invoice-failed:INV-0001:ops@example.test",
    });

    expect(result.status).toBe("delivered");
    expect(result.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.recipientKind).toBe("email");
    expect(channel.size()).toBe(1);

    const [recorded] = channel.getSent();
    expect(recorded?.template).toBe("INVOICE_PAYMENT_FAILED_V1");
    expect(recorded?.recipient.address).toBe("ops@example.test");
    expect(recorded?.context["invoiceNumber"]).toBe("INV-0001");
  });

  it("dedupes a second send with the same idempotencyKey", async () => {
    const channel = new InMemoryNotificationChannel();

    const first = await channel.send({
      to: { kind: "in-app", address: "user-123" },
      template: "ORDER_HOLD_EXPIRY_REMINDER_V1",
      context: validHoldContext,
      idempotencyKey: "hold-expiry:ORD-EXT-42",
    });
    const second = await channel.send({
      to: { kind: "in-app", address: "user-123" },
      template: "ORDER_HOLD_EXPIRY_REMINDER_V1",
      context: validHoldContext,
      idempotencyKey: "hold-expiry:ORD-EXT-42",
    });

    expect(first.status).toBe("delivered");
    expect(second.status).toBe("deduplicated");
    expect(second.deliveryId).toBe(first.deliveryId);
    expect(channel.size()).toBe(1);
  });

  it("getSentForTemplate filters by template id", async () => {
    const channel = new InMemoryNotificationChannel();

    await channel.send({
      to: { kind: "in-app", address: "ops-1" },
      template: "SHIPMENT_ESCALATED_V1",
      context: {
        orderExternalNumber: "ORD-EXT-1",
        escalationReason: "STUCK_IN_TRANSIT",
        lastTrackingStatus: "in_transit",
      },
      idempotencyKey: "esc:1",
    });
    await channel.send({
      to: { kind: "email", address: "ops@example.test" },
      template: "INVOICE_PAYMENT_FAILED_V1",
      context: validInvoiceContext,
      idempotencyKey: "invoice:1",
    });

    expect(channel.getSentForTemplate("SHIPMENT_ESCALATED_V1").length).toBe(1);
    expect(channel.getSentForTemplate("INVOICE_PAYMENT_FAILED_V1").length).toBe(1);
    expect(channel.getSentForTemplate("ORDER_PV1_REJECTED_V1").length).toBe(0);
  });

  it("clear() drops recorded sends and reopens the dedup window", async () => {
    const channel = new InMemoryNotificationChannel();
    await channel.send({
      to: { kind: "in-app", address: "u" },
      template: "ORDER_PV1_REJECTED_V1",
      context: { orderExternalNumber: "ORD-1", rejectionReason: "wrong sig" },
      idempotencyKey: "k",
    });
    expect(channel.size()).toBe(1);

    channel.clear();

    expect(channel.size()).toBe(0);

    const fresh = await channel.send({
      to: { kind: "in-app", address: "u" },
      template: "ORDER_PV1_REJECTED_V1",
      context: { orderExternalNumber: "ORD-1", rejectionReason: "wrong sig" },
      idempotencyKey: "k",
    });
    expect(fresh.status).toBe("delivered");
  });

  it("preserves an optional correlationId in the recorded payload", async () => {
    const channel = new InMemoryNotificationChannel();
    await channel.send({
      to: { kind: "in-app", address: "u" },
      template: "ORDER_PV1_REJECTED_V1",
      context: { orderExternalNumber: "ORD-1", rejectionReason: "wrong sig" },
      idempotencyKey: "k",
      correlationId: "trace-abc",
    });
    expect(channel.getSent()[0]?.correlationId).toBe("trace-abc");
  });
});

describe("InMemoryNotificationChannel — validation guards", () => {
  it("rejects a recipient kind the channel does not support", async () => {
    const channel = new InMemoryNotificationChannel({
      supportedRecipientKinds: ["in-app"],
    });

    await expect(
      channel.send({
        to: { kind: "email", address: "ops@example.test" },
        template: "INVOICE_PAYMENT_FAILED_V1",
        context: validInvoiceContext,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_RECIPIENT_KIND_UNSUPPORTED" });
  });

  it("rejects a recipient kind the template does not list", async () => {
    const channel = new InMemoryNotificationChannel();

    // INVOICE_PAYMENT_FAILED_V1 supports email + in-app, NOT sms.
    await expect(
      channel.send({
        to: { kind: "sms", address: "+15555550000" },
        template: "INVOICE_PAYMENT_FAILED_V1",
        context: validInvoiceContext,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_TEMPLATE_RECIPIENT_MISMATCH" });
  });

  it("rejects a context missing a required key", async () => {
    const channel = new InMemoryNotificationChannel();

    await expect(
      channel.send({
        to: { kind: "email", address: "ops@example.test" },
        template: "INVOICE_PAYMENT_FAILED_V1",
        context: {
          // intentionally missing clinicName
          invoiceNumber: "INV-1",
          amountDueCents: 100,
        },
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({
      code: "NOTIFICATION_CONTEXT_MISSING_KEY",
      metadata: expect.objectContaining({ missingKey: "clinicName" }),
    });
  });
});

describe("InMemoryNotificationChannel — PHI safety", () => {
  it("rejects a context whose key matches an exact sentinel", async () => {
    const channel = new InMemoryNotificationChannel();

    await expect(
      channel.send({
        to: { kind: "email", address: "ops@example.test" },
        template: "INVOICE_PAYMENT_FAILED_V1",
        context: {
          ...validInvoiceContext,
          firstName: "REDACTED-LOOKS-LIKE-PHI",
        },
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({
      code: "NOTIFICATION_PHI_REJECTED",
      metadata: expect.objectContaining({ offendingKey: "firstName" }),
    });
  });

  it("rejects a context whose key matches a sentinel prefix (ssn*, dob*, phone*, email*)", async () => {
    const channel = new InMemoryNotificationChannel();

    for (const offendingKey of ["ssnLast4", "dobYear", "phoneE164", "emailHash"]) {
      await expect(
        channel.send({
          to: { kind: "email", address: "ops@example.test" },
          template: "INVOICE_PAYMENT_FAILED_V1",
          context: {
            ...validInvoiceContext,
            [offendingKey]: "x",
          },
          idempotencyKey: `k:${offendingKey}`,
        })
      ).rejects.toMatchObject({
        code: "NOTIFICATION_PHI_REJECTED",
        metadata: expect.objectContaining({ offendingKey }),
      });
    }
  });

  it("PHI is rejected even when the channel is PHI-capable, if the template is not", async () => {
    const channel = new InMemoryNotificationChannel({ phiCapable: true });

    await expect(
      channel.send({
        to: { kind: "email", address: "ops@example.test" },
        template: "INVOICE_PAYMENT_FAILED_V1",
        context: { ...validInvoiceContext, lastName: "x" },
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({
      code: "NOTIFICATION_PHI_REJECTED",
      metadata: expect.objectContaining({
        templatePhiAllowed: false,
        channelPhiCapable: true,
      }),
    });
  });

  it("never echoes the PHI value into the error envelope", async () => {
    const channel = new InMemoryNotificationChannel();
    const phiValue = "VERY-SECRET-PHI-VALUE-XYZ";

    try {
      await channel.send({
        to: { kind: "email", address: "ops@example.test" },
        template: "INVOICE_PAYMENT_FAILED_V1",
        context: { ...validInvoiceContext, firstName: phiValue },
        idempotencyKey: "k",
      });
      throw new Error("should have rejected");
    } catch (err) {
      const json = JSON.stringify(err);
      // The metadata only carries the KEY NAME, never the value.
      expect(json).not.toContain(phiValue);
    }
  });
});

describe("InMemoryNotificationChannel — failNext", () => {
  it("surfaces the queued failure as an InternalError on the next send", async () => {
    const channel = new InMemoryNotificationChannel();
    channel.failNext({ code: "RESEND_5XX", message: "vendor down" });

    await expect(
      channel.send({
        to: { kind: "email", address: "ops@example.test" },
        template: "INVOICE_PAYMENT_FAILED_V1",
        context: validInvoiceContext,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "RESEND_5XX" });

    // The failure was one-shot; the next call should succeed.
    const ok = await channel.send({
      to: { kind: "email", address: "ops@example.test" },
      template: "INVOICE_PAYMENT_FAILED_V1",
      context: validInvoiceContext,
      idempotencyKey: "k2",
    });
    expect(ok.status).toBe("delivered");
  });

  it("validation errors win over a queued failure (failure stays queued)", async () => {
    const channel = new InMemoryNotificationChannel();
    channel.failNext();

    await expect(
      channel.send({
        to: { kind: "email", address: "ops@example.test" },
        template: "INVOICE_PAYMENT_FAILED_V1",
        context: {
          // missing required keys; validation must fire first
        },
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONTEXT_MISSING_KEY" });

    // Failure was NOT consumed — the next valid send hits it.
    await expect(
      channel.send({
        to: { kind: "email", address: "ops@example.test" },
        template: "INVOICE_PAYMENT_FAILED_V1",
        context: validInvoiceContext,
        idempotencyKey: "k2",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_TRANSPORT_ERROR" });
  });
});
