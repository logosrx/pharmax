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

function buildChannel(api: ResendSendApi): ResendNotificationChannel {
  return new ResendNotificationChannel({
    apiKey: "re_test",
    fromAddress: "reports@pharmax.test",
    sendApi: api,
  });
}

function vendorErrorApi(error: { name?: string; message?: string }): ResendSendApi {
  return { send: vi.fn(async () => ({ data: null, error })) };
}

describe("ResendNotificationChannel — vendor error classification", () => {
  // The adapter maps EVERY vendor rejection to a thrown
  // NOTIFICATION_TRANSPORT_ERROR: nothing resolves without a Resend
  // message id, so no notification can be dropped without a recorded
  // reason. There is deliberately NO retryable-vs-permanent split at
  // this seam — the Resend SDK error envelope carries {name, message}
  // with no HTTP status, the outbox drainer retries every transport
  // error with backoff, and a permanent rejection (validation error,
  // suppressed/bounced address) burns through the drainer's attempt
  // ceiling to DEAD rather than being misfiled as delivered. The
  // vendor's error name is preserved in metadata so an operator can
  // tell a rate limit from a validation failure in the DEAD row.
  // Suppression-list rejections surface through this same envelope
  // (Resend suppresses server-side; there is no client-side
  // suppression branch in this adapter).
  it.each([
    { scenario: "429 rate limit", vendorErrorName: "rate_limit_exceeded" },
    { scenario: "5xx internal error", vendorErrorName: "internal_server_error" },
    { scenario: "5xx application error", vendorErrorName: "application_error" },
    { scenario: "4xx validation (permanent)", vendorErrorName: "validation_error" },
    { scenario: "4xx unverified sender domain (permanent)", vendorErrorName: "not_allowed" },
  ])(
    "$scenario → throws NOTIFICATION_TRANSPORT_ERROR preserving vendorErrorName=$vendorErrorName",
    async ({ vendorErrorName }) => {
      const channel = buildChannel(
        vendorErrorApi({ name: vendorErrorName, message: `vendor said: ${vendorErrorName}` })
      );
      await expect(
        channel.send({
          to: { kind: "email", address: "admin@acme.test" },
          template: "REPORT_RUN_COMPLETED_V1",
          context: VALID_CONTEXT,
          idempotencyKey: `class-${vendorErrorName}`,
        })
      ).rejects.toMatchObject({
        code: "NOTIFICATION_TRANSPORT_ERROR",
        metadata: expect.objectContaining({
          vendorErrorName,
          channelName: "resend-email",
          template: "REPORT_RUN_COMPLETED_V1",
        }),
      });
    }
  );

  it("records vendorErrorName: null and an 'unknown error' message for a nameless envelope", async () => {
    const channel = buildChannel(vendorErrorApi({}));
    await expect(
      channel.send({
        to: { kind: "email", address: "admin@acme.test" },
        template: "REPORT_RUN_COMPLETED_V1",
        context: VALID_CONTEXT,
        idempotencyKey: "k-nameless",
      })
    ).rejects.toMatchObject({
      code: "NOTIFICATION_TRANSPORT_ERROR",
      message: expect.stringContaining("unknown error"),
      metadata: expect.objectContaining({ vendorErrorName: null }),
    });
  });

  it("treats a malformed response (no data AND no error) as a loud transport error", async () => {
    const api: ResendSendApi = { send: vi.fn(async () => ({ data: null, error: null })) };
    const channel = buildChannel(api);
    await expect(
      channel.send({
        to: { kind: "email", address: "admin@acme.test" },
        template: "REPORT_RUN_COMPLETED_V1",
        context: VALID_CONTEXT,
        idempotencyKey: "k-malformed",
      })
    ).rejects.toMatchObject({
      code: "NOTIFICATION_TRANSPORT_ERROR",
      message: expect.stringContaining("malformed"),
    });
  });

  it("preserves the underlying network error as `cause` for Sentry", async () => {
    const underlying = new Error("ECONNRESET");
    const api: ResendSendApi = {
      send: vi.fn(async () => {
        throw underlying;
      }),
    };
    const channel = buildChannel(api);
    let thrown: unknown;
    try {
      await channel.send({
        to: { kind: "email", address: "admin@acme.test" },
        template: "REPORT_RUN_COMPLETED_V1",
        context: VALID_CONTEXT,
        idempotencyKey: "k-cause",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { cause?: unknown }).cause).toBe(underlying);
  });
});

const DIGEST_CONTEXT = {
  generatedAtIso: "2026-08-01T02:30:00.000Z",
  windowFromIso: "2026-07-31T02:30:00.000Z",
  windowToIso: "2026-08-01T02:30:00.000Z",
  digestText: "All audit chains verified. No break-glass sessions in window.",
  auditOrgCount: 3,
  brokenChainCount: 0,
  breakGlassCount: 0,
  outboxDeadCount: 0,
} as const;

const COMPLIANCE_CONTEXT = {
  noticeKind: "quarterly-access-review",
  organizationId: "11111111-1111-1111-1111-000000000001",
  subject: "Q3 access review evidence pack is ready",
  body: "Walk the attached evidence pack and record the sign-off.",
  severity: "warning",
} as const;

const PORTAL_SHIPPED_CONTEXT = {
  orderExternalNumber: "RX-1001",
  rxNumbers: "700123, 700124",
  shippedAtIso: "2026-08-01T15:00:00.000Z",
} as const;

describe("ResendNotificationChannel — renderer routing per template", () => {
  it("renders SECURITY_DIGEST_DAILY_V1 and embeds the digest text verbatim", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    const result = await channel.send({
      to: { kind: "email", address: "security@pharmax.test" },
      template: "SECURITY_DIGEST_DAILY_V1",
      context: DIGEST_CONTEXT,
      idempotencyKey: "digest-2026-08-01",
    });
    expect(result.status).toBe("delivered");
    const call = fake.sends[0] as { subject: string; text: string };
    expect(call.text).toContain(DIGEST_CONTEXT.digestText);
    expect(call.subject.length).toBeGreaterThan(0);
  });

  it("rejects a non-finite digest count BEFORE any transport call (NaN never becomes a '0' subject)", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    await expect(
      channel.send({
        to: { kind: "email", address: "security@pharmax.test" },
        template: "SECURITY_DIGEST_DAILY_V1",
        context: { ...DIGEST_CONTEXT, brokenChainCount: Number.NaN },
        idempotencyKey: "digest-nan",
      })
    ).rejects.toMatchObject({
      code: "NOTIFICATION_CONTEXT_INVALID",
      metadata: expect.objectContaining({ field: "brokenChainCount" }),
    });
    expect(fake.sends).toHaveLength(0);
  });

  it("renders COMPLIANCE_NOTICE_V1 for each valid severity, with and without evidenceUri", async () => {
    for (const severity of ["info", "warning", "critical"] as const) {
      const fake = buildFakeApi();
      const channel = buildChannel(fake.api);
      await channel.send({
        to: { kind: "email", address: "compliance@pharmax.test" },
        template: "COMPLIANCE_NOTICE_V1",
        context: { ...COMPLIANCE_CONTEXT, severity },
        idempotencyKey: `notice-${severity}`,
      });
      expect(fake.sends).toHaveLength(1);
    }
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    await channel.send({
      to: { kind: "email", address: "compliance@pharmax.test" },
      template: "COMPLIANCE_NOTICE_V1",
      context: { ...COMPLIANCE_CONTEXT, evidenceUri: "s3://audit-evidence/q3/pack.pdf" },
      idempotencyKey: "notice-evidence",
    });
    expect(fake.sends).toHaveLength(1);
  });

  it("rejects an invalid compliance severity BEFORE any transport call", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    await expect(
      channel.send({
        to: { kind: "email", address: "compliance@pharmax.test" },
        template: "COMPLIANCE_NOTICE_V1",
        context: { ...COMPLIANCE_CONTEXT, severity: "catastrophic" },
        idempotencyKey: "notice-bad-severity",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONTEXT_INVALID" });
    expect(fake.sends).toHaveLength(0);
  });

  it("renders PORTAL_ORDER_SHIPPED_V1 with the tracking number when present", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    await channel.send({
      to: { kind: "email", address: "prescriber@clinic.test" },
      template: "PORTAL_ORDER_SHIPPED_V1",
      context: { ...PORTAL_SHIPPED_CONTEXT, trackingNumber: "1Z-TEST-TRACK-0001" },
      idempotencyKey: "shipped-with-tracking",
    });
    const call = fake.sends[0] as { text: string };
    expect(call.text).toContain("1Z-TEST-TRACK-0001");
  });

  it("renders PORTAL_ORDER_SHIPPED_V1 without a tracking number (pending-carrier-scan copy)", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    await channel.send({
      to: { kind: "email", address: "prescriber@clinic.test" },
      template: "PORTAL_ORDER_SHIPPED_V1",
      context: PORTAL_SHIPPED_CONTEXT,
      idempotencyKey: "shipped-no-tracking",
    });
    const call = fake.sends[0] as { text: string };
    expect(call.text).toContain("Tracking will be available");
  });

  it("rejects an invalid report runStatus BEFORE any transport call", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    await expect(
      channel.send({
        to: { kind: "email", address: "admin@acme.test" },
        template: "REPORT_RUN_COMPLETED_V1",
        context: { ...VALID_CONTEXT, runStatus: "EXPLODED" },
        idempotencyKey: "report-bad-status",
      })
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONTEXT_INVALID" });
    expect(fake.sends).toHaveLength(0);
  });

  it("renders a FAILED report run with the optional errorCode and downloadLink present", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    const result = await channel.send({
      to: { kind: "email", address: "admin@acme.test" },
      template: "REPORT_RUN_COMPLETED_V1",
      context: {
        ...VALID_CONTEXT,
        runStatus: "FAILED",
        errorCode: "REPORT_QUERY_TIMEOUT",
        downloadLink: "https://ops.pharmax.test/api/ops/reports/runs/run-1/download",
      },
      idempotencyKey: "report-failed",
    });
    expect(result.status).toBe("delivered");
    expect(fake.sends).toHaveLength(1);
  });
});

describe("ResendNotificationChannel — emergency escalation templates deliver", () => {
  // REGRESSION (the bug this suite originally pinned): both
  // emergency-escalation templates were email-capable in the
  // registry and sent by the notify-on-order-escalated outbox
  // handler, but `renderTemplate` had no case for them — every
  // escalation email threw NOTIFICATION_RENDERER_MISSING for every
  // recipient, the handler threw, and the outbox row retried until
  // DEAD. Escalation email delivery was impossible in a
  // Resend-configured environment. These tests pin the fix: both
  // templates render and reach the transport.
  it("delivers an ORDER_SLA_BREACH_ESCALATED_V1 email", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    const result = await channel.send({
      to: { kind: "email", address: "ops@acme.test" },
      template: "ORDER_SLA_BREACH_ESCALATED_V1",
      context: {
        orderExternalNumber: "RX-1001",
        slaDeadlineAtIso: "2026-08-01T10:00:00.000Z",
        breachedAtIso: "2026-08-01T10:05:00.000Z",
      },
      idempotencyKey: "esc-deliverable",
    });
    expect(result.status).toBe("delivered");
    expect(fake.sends).toHaveLength(1);
    const call = fake.sends[0] as { subject: string; text: string; html: string };
    expect(call.subject).toContain("RX-1001");
    expect(call.text).toContain("2026-08-01T10:00:00.000Z");
    expect(call.text).toContain("2026-08-01T10:05:00.000Z");
    expect(call.html).toContain("SLA BREACH");
  });

  it("delivers a SHIPMENT_ESCALATED_V1 email", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    const result = await channel.send({
      to: { kind: "email", address: "ops@acme.test" },
      template: "SHIPMENT_ESCALATED_V1",
      context: {
        orderExternalNumber: "RX-1001",
        escalationReason: "DELIVERY_EXCEPTION",
        lastTrackingStatus: "RETURNED",
      },
      idempotencyKey: "esc-shipment-deliverable",
    });
    expect(result.status).toBe("delivered");
    expect(fake.sends).toHaveLength(1);
    const call = fake.sends[0] as { subject: string; text: string; html: string };
    expect(call.subject).toContain("RX-1001");
    expect(call.text).toContain("DELIVERY_EXCEPTION");
    expect(call.text).toContain("RETURNED");
    expect(call.html).toContain("SHIPMENT EXCEPTION");
  });
});

describe("ResendNotificationChannel — templates with no renderer fail LOUDLY", () => {
  // INVOICE_FINALIZED_V1 is email-capable in the registry but is on
  // the channel's documented KnownUnrenderedEmailTemplateId list —
  // no worker path dispatches it through email yet. Should a
  // dispatch path ship before its renderer, the channel must
  // surface that as a loud wiring error rather than send a blank
  // email — this test pins the loud default branch.
  it("INVOICE_FINALIZED_V1 → NOTIFICATION_RENDERER_MISSING, no transport call", async () => {
    const fake = buildFakeApi();
    const channel = buildChannel(fake.api);
    await expect(
      channel.send({
        to: { kind: "email", address: "billing@acme.test" },
        template: "INVOICE_FINALIZED_V1",
        context: {
          invoiceNumber: "INV-2026-0042",
          totalCents: 125_00,
          dueDate: "2026-09-01",
          hostedInvoiceUrl: "https://invoice.stripe.test/i/inv_42",
        },
        idempotencyKey: "invoice-unrendered",
      })
    ).rejects.toMatchObject({
      code: "NOTIFICATION_RENDERER_MISSING",
      metadata: expect.objectContaining({ templateId: "INVOICE_FINALIZED_V1" }),
    });
    expect(fake.sends).toHaveLength(0);
  });
});

describe("ResendNotificationChannel — construction", () => {
  it("reports the default channel metadata (name, email-only, NOT phi-capable)", () => {
    const channel = buildChannel(buildFakeApi().api);
    expect(channel.metadata).toEqual({
      name: "resend-email",
      supportedRecipientKinds: ["email"],
      phiCapable: false,
    });
    expect(Object.isFrozen(channel.metadata)).toBe(true);
  });

  it("honors a custom channel name", () => {
    const channel = new ResendNotificationChannel({
      apiKey: "re_test",
      fromAddress: "reports@pharmax.test",
      sendApi: buildFakeApi().api,
      name: "resend-email-eu",
    });
    expect(channel.metadata.name).toBe("resend-email-eu");
  });

  it("constructs the real SDK adapter when no sendApi override is given (no network until send)", () => {
    const channel = new ResendNotificationChannel({
      apiKey: "re_test",
      fromAddress: "reports@pharmax.test",
    });
    expect(channel.metadata.name).toBe("resend-email");
  });
});
