import { describe, expect, it, vi } from "vitest";

import {
  TwilioSmsNotificationChannel,
  type TwilioMessagesApi,
  type TwilioMessageResult,
} from "./twilio-sms-notification-channel.js";

const VALID_CONTEXT = {
  orderExternalNumber: "RX-100245",
  escalationReason: "SLA_BREACH",
  lastTrackingStatus: "in_transit",
} as const;

function buildFakeApi(
  result: TwilioMessageResult = {
    sid: "SM-1",
    status: "accepted",
    errorCode: null,
    errorMessage: null,
  }
): { api: TwilioMessagesApi; sends: Array<unknown> } {
  const sends: Array<unknown> = [];
  return {
    sends,
    api: {
      create: vi.fn(async (input: unknown) => {
        sends.push(input);
        return result;
      }),
    },
  };
}

function buildChannel(api: TwilioMessagesApi): TwilioSmsNotificationChannel {
  return new TwilioSmsNotificationChannel({
    accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    authToken: "test-token",
    messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    messagesApi: api,
  });
}

describe("TwilioSmsNotificationChannel — happy path", () => {
  it("sends via the Messaging Service SID and maps `accepted` to queued", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);

    const result = await channel.send({
      to: { kind: "sms", address: "+15555550123" },
      template: "SHIPMENT_ESCALATED_V1",
      context: VALID_CONTEXT,
      idempotencyKey: "escalation:abc",
    });

    expect(result.status).toBe("queued");
    expect(result.deliveryId).toBe("SM-1");
    expect(result.recipientKind).toBe("sms");
    expect(fake.sends).toHaveLength(1);

    const call = fake.sends[0] as { to: string; messagingServiceSid: string; body: string };
    expect(call.to).toBe("+15555550123");
    expect(call.messagingServiceSid).toBe("MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    // Body carries the internal order number + reason, never PHI.
    expect(call.body).toContain("RX-100245");
    expect(call.body).toContain("SLA_BREACH");
  });

  it("maps a `delivered` status to delivered", async () => {
    const fake = buildFakeApi({
      sid: "SM-2",
      status: "delivered",
      errorCode: null,
      errorMessage: null,
    });
    const channel = buildChannel(fake.api);

    const result = await channel.send({
      to: { kind: "sms", address: "+15555550123" },
      template: "SHIPMENT_ESCALATED_V1",
      context: VALID_CONTEXT,
      idempotencyKey: "escalation:def",
    });

    expect(result.status).toBe("delivered");
  });
});

describe("TwilioSmsNotificationChannel — guards", () => {
  it("rejects non-sms recipient kinds via the standard guard", async () => {
    const channel = buildChannel(buildFakeApi().api);
    await expect(
      channel.send({
        to: { kind: "email", address: "ops@acme.test" },
        template: "SHIPMENT_ESCALATED_V1",
        context: VALID_CONTEXT,
        idempotencyKey: "k1",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_RECIPIENT_KIND_UNSUPPORTED" });
  });

  it("rejects a template that does not list `sms` in channelKinds", async () => {
    const channel = buildChannel(buildFakeApi().api);
    await expect(
      channel.send({
        to: { kind: "sms", address: "+15555550123" },
        // PV1-rejected is in-app only — not SMS-capable.
        template: "ORDER_PV1_REJECTED_V1",
        context: { orderExternalNumber: "RX-1", rejectionReason: "DOSE_MISMATCH" },
        idempotencyKey: "k2",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_TEMPLATE_RECIPIENT_MISMATCH" });
  });

  it("rejects PHI-looking context keys (e.g. patientFirstName)", async () => {
    const channel = buildChannel(buildFakeApi().api);
    await expect(
      channel.send({
        to: { kind: "sms", address: "+15555550123" },
        template: "SHIPMENT_ESCALATED_V1",
        context: { ...VALID_CONTEXT, patientFirstName: "Jane" },
        idempotencyKey: "k3",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_PHI_REJECTED" });
  });

  it("rejects a missing required context key", async () => {
    const channel = buildChannel(buildFakeApi().api);
    const { lastTrackingStatus: _omit, ...rest } = VALID_CONTEXT;
    await expect(
      channel.send({
        to: { kind: "sms", address: "+15555550123" },
        template: "SHIPMENT_ESCALATED_V1",
        context: rest,
        idempotencyKey: "k4",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONTEXT_MISSING_KEY" });
  });
});

describe("TwilioSmsNotificationChannel — transport errors", () => {
  it("translates a Twilio error_code / failed status to NOTIFICATION_TRANSPORT_ERROR", async () => {
    const api: TwilioMessagesApi = {
      // 21610: recipient has unsubscribed (replied STOP).
      create: vi.fn(async () => ({
        sid: "SM-3",
        status: "failed",
        errorCode: 21610,
        errorMessage: "Attempt to send to unsubscribed recipient",
      })),
    };
    const channel = buildChannel(api);
    await expect(
      channel.send({
        to: { kind: "sms", address: "+15555550123" },
        template: "SHIPMENT_ESCALATED_V1",
        context: VALID_CONTEXT,
        idempotencyKey: "k5",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_TRANSPORT_ERROR" });
  });

  it("translates a thrown network error to NOTIFICATION_TRANSPORT_ERROR", async () => {
    const api: TwilioMessagesApi = {
      create: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    };
    const channel = buildChannel(api);
    await expect(
      channel.send({
        to: { kind: "sms", address: "+15555550123" },
        template: "SHIPMENT_ESCALATED_V1",
        context: VALID_CONTEXT,
        idempotencyKey: "k6",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_TRANSPORT_ERROR" });
  });
});
