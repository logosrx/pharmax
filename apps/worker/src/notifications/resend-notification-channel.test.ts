import { describe, expect, it, vi } from "vitest";

import { ResendNotificationChannel, type ResendSendApi } from "./resend-notification-channel.js";

const VALID_CONTEXT = {
  scheduleName: "Weekly volume",
  reportTitle: "Order volume by stage",
  runStatus: "SUCCEEDED",
  windowFromIso: "2026-05-21T00:00:00.000Z",
  windowToIso: "2026-05-28T00:00:00.000Z",
  generatedAtIso: "2026-05-28T13:00:00.000Z",
  rowCount: 100,
  dashboardLink: "https://ops.pharmax.test/ops/reports/order-volume",
  aggregates: { totalShipped: 100 },
} as const;

function buildFakeApi(): { api: ResendSendApi; sends: Array<unknown> } {
  const sends: Array<unknown> = [];
  return {
    sends,
    api: {
      send: vi.fn(async (input: unknown) => {
        sends.push(input);
        return { data: { id: "msg-1" }, error: null };
      }),
    },
  };
}

describe("ResendNotificationChannel — happy path", () => {
  it("sends the rendered subject/text/html with Idempotency-Key header", async () => {
    const fake = buildFakeApi();
    const channel = new ResendNotificationChannel({
      apiKey: "re_test",
      fromAddress: "reports@pharmax.test",
      sendApi: fake.api,
    });
    const result = await channel.send({
      to: { kind: "email", address: "admin@acme.test" },
      template: "REPORT_RUN_COMPLETED_V1",
      context: VALID_CONTEXT,
      idempotencyKey: "report-run:abc",
    });
    expect(result.status).toBe("delivered");
    expect(result.deliveryId).toBe("msg-1");
    expect(fake.sends).toHaveLength(1);
    const call = fake.sends[0] as {
      from: string;
      to: ReadonlyArray<string>;
      subject: string;
      headers: Record<string, string>;
    };
    expect(call.from).toBe("reports@pharmax.test");
    expect(call.to).toEqual(["admin@acme.test"]);
    expect(call.headers["Idempotency-Key"]).toBe("report-run:abc");
    expect(call.subject).toContain("Weekly volume");
  });
});

describe("ResendNotificationChannel — guards", () => {
  it("rejects non-email recipient kinds via the standard guard", async () => {
    const fake = buildFakeApi();
    const channel = new ResendNotificationChannel({
      apiKey: "re_test",
      fromAddress: "reports@pharmax.test",
      sendApi: fake.api,
    });
    await expect(
      channel.send({
        to: { kind: "sms", address: "+15555550100" },
        template: "REPORT_RUN_COMPLETED_V1",
        context: VALID_CONTEXT,
        idempotencyKey: "k1",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_RECIPIENT_KIND_UNSUPPORTED" });
  });

  it("rejects PHI-looking context keys (e.g. patientFirstName)", async () => {
    const fake = buildFakeApi();
    const channel = new ResendNotificationChannel({
      apiKey: "re_test",
      fromAddress: "reports@pharmax.test",
      sendApi: fake.api,
    });
    await expect(
      channel.send({
        to: { kind: "email", address: "admin@acme.test" },
        template: "REPORT_RUN_COMPLETED_V1",
        context: { ...VALID_CONTEXT, patientFirstName: "Jane" },
        idempotencyKey: "k2",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_PHI_REJECTED" });
  });

  it("rejects missing required context key", async () => {
    const fake = buildFakeApi();
    const channel = new ResendNotificationChannel({
      apiKey: "re_test",
      fromAddress: "reports@pharmax.test",
      sendApi: fake.api,
    });
    const { scheduleName: _omit, ...rest } = VALID_CONTEXT;
    await expect(
      channel.send({
        to: { kind: "email", address: "admin@acme.test" },
        template: "REPORT_RUN_COMPLETED_V1",
        context: rest,
        idempotencyKey: "k3",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONTEXT_MISSING_KEY" });
  });
});

describe("ResendNotificationChannel — transport errors", () => {
  it("translates a Resend error envelope to NOTIFICATION_TRANSPORT_ERROR", async () => {
    const api: ResendSendApi = {
      send: vi.fn(async () => ({
        data: null,
        error: { name: "validation_error", message: "bad domain" },
      })),
    };
    const channel = new ResendNotificationChannel({
      apiKey: "re_test",
      fromAddress: "reports@pharmax.test",
      sendApi: api,
    });
    await expect(
      channel.send({
        to: { kind: "email", address: "admin@acme.test" },
        template: "REPORT_RUN_COMPLETED_V1",
        context: VALID_CONTEXT,
        idempotencyKey: "k4",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_TRANSPORT_ERROR" });
  });

  it("translates a thrown network error to NOTIFICATION_TRANSPORT_ERROR", async () => {
    const api: ResendSendApi = {
      send: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    };
    const channel = new ResendNotificationChannel({
      apiKey: "re_test",
      fromAddress: "reports@pharmax.test",
      sendApi: api,
    });
    await expect(
      channel.send({
        to: { kind: "email", address: "admin@acme.test" },
        template: "REPORT_RUN_COMPLETED_V1",
        context: VALID_CONTEXT,
        idempotencyKey: "k5",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_TRANSPORT_ERROR" });
  });
});
