// Unit coverage for NotificationChannelComplianceNotifier.
//
// We assert ONLY the adapter's responsibilities — context shape,
// idempotency key semantics, recipient pinning, organizationId
// pass-through, error propagation. Rendering lives in
// render-compliance-notice-email.ts (own tests); the PHI sentinel
// gate + required-key gate live in @pharmax/notifications.

import {
  type NotificationChannel,
  type NotificationChannelMetadata,
  type NotificationSendInput,
  type NotificationSendResult,
} from "@pharmax/notifications";
import { beforeEach, describe, expect, it } from "vitest";

import { type ComplianceNotice } from "./compliance-notifier.js";
import { NotificationChannelComplianceNotifier } from "./notification-channel-compliance-notifier.js";

function buildNotice(overrides?: Partial<ComplianceNotice>): ComplianceNotice {
  return {
    kind: "access-review.ready",
    organizationId: "org_acme",
    subject: "Q2 2026 access review ready for acme",
    body: "Walk the evidence pack and dispatch the sign-off command.\nAnomalies: 0",
    severity: "info",
    evidenceUri: "s3://audit-archive/access-reviews/2026-Q2/org_acme.md",
    ...overrides,
  };
}

interface FakeChannel extends NotificationChannel {
  readonly sends: ReadonlyArray<NotificationSendInput>;
}

function makeChannel(opts?: { readonly throwError?: Error }): FakeChannel {
  const sends: NotificationSendInput[] = [];
  const metadata: NotificationChannelMetadata = Object.freeze({
    name: "fake-channel",
    supportedRecipientKinds: Object.freeze(["email"]) as ReadonlyArray<"email">,
    phiCapable: false,
  });
  const channel: FakeChannel = {
    metadata,
    sends,
    async send(input: NotificationSendInput): Promise<NotificationSendResult> {
      sends.push(input);
      if (opts?.throwError) throw opts.throwError;
      return Object.freeze({
        deliveryId: "msg_compliance_001",
        status: "delivered" as const,
        recipientKind: "email" as const,
        sentAt: new Date("2026-07-01T03:00:01.000Z"),
      });
    },
  };
  return channel;
}

describe("NotificationChannelComplianceNotifier — construction", () => {
  it("throws when recipientEmail is empty", () => {
    expect(
      () =>
        new NotificationChannelComplianceNotifier({
          channel: makeChannel(),
          recipientEmail: "",
        })
    ).toThrow(/recipientEmail/);
  });

  it("throws when recipientEmail is whitespace-only", () => {
    expect(
      () =>
        new NotificationChannelComplianceNotifier({
          channel: makeChannel(),
          recipientEmail: "   ",
        })
    ).toThrow(/recipientEmail/);
  });
});

describe("NotificationChannelComplianceNotifier — notify", () => {
  let channel: FakeChannel;
  let notifier: NotificationChannelComplianceNotifier;

  beforeEach(() => {
    channel = makeChannel();
    notifier = new NotificationChannelComplianceNotifier({
      channel,
      recipientEmail: "compliance@pharmax-operator.example",
    });
  });

  it("sends via COMPLIANCE_NOTICE_V1 to the pinned recipient", async () => {
    await notifier.notify(buildNotice());
    expect(channel.sends).toHaveLength(1);
    const send = channel.sends[0]!;
    expect(send.template).toBe("COMPLIANCE_NOTICE_V1");
    expect(send.to).toEqual({ kind: "email", address: "compliance@pharmax-operator.example" });
  });

  it("builds the full context including optional evidenceUri", async () => {
    await notifier.notify(buildNotice());
    const context = channel.sends[0]!.context;
    expect(context).toEqual({
      noticeKind: "access-review.ready",
      organizationId: "org_acme",
      subject: "Q2 2026 access review ready for acme",
      body: "Walk the evidence pack and dispatch the sign-off command.\nAnomalies: 0",
      severity: "info",
      evidenceUri: "s3://audit-archive/access-reviews/2026-Q2/org_acme.md",
    });
  });

  it("omits evidenceUri from context when the notice has none", async () => {
    const { evidenceUri: _dropped, ...withoutEvidence } = buildNotice();
    await notifier.notify(withoutEvidence);
    expect(channel.sends[0]!.context).not.toHaveProperty("evidenceUri");
  });

  it("defaults severity to info when the notice omits it", async () => {
    const { severity: _dropped, ...withoutSeverity } = buildNotice();
    await notifier.notify(withoutSeverity);
    expect(channel.sends[0]!.context["severity"]).toBe("info");
  });

  it("passes organizationId through for the delivery ledger", async () => {
    await notifier.notify(buildNotice());
    expect(channel.sends[0]!.organizationId).toBe("org_acme");
  });

  it("returns the channel delivery id as transportId", async () => {
    const result = await notifier.notify(buildNotice());
    expect(result.transportId).toBe("msg_compliance_001");
  });

  it("derives a stable idempotency key for the same notice", async () => {
    await notifier.notify(buildNotice());
    await notifier.notify(buildNotice());
    const [first, second] = channel.sends;
    expect(first!.idempotencyKey).toBe(second!.idempotencyKey);
    expect(first!.idempotencyKey).toMatch(/^compliance-notice:access-review\.ready:/);
  });

  it("derives distinct keys when the subject changes (next quarter)", async () => {
    await notifier.notify(buildNotice());
    await notifier.notify(buildNotice({ subject: "Q3 2026 access review ready for acme" }));
    const [first, second] = channel.sends;
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
  });

  it("derives distinct keys for different organizations", async () => {
    await notifier.notify(buildNotice());
    await notifier.notify(buildNotice({ organizationId: "org_globex" }));
    const [first, second] = channel.sends;
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
  });

  it("honors a custom idempotencyKeyPrefix", async () => {
    const custom = new NotificationChannelComplianceNotifier({
      channel,
      recipientEmail: "compliance@pharmax-operator.example",
      idempotencyKeyPrefix: "custom-prefix",
    });
    await custom.notify(buildNotice());
    expect(channel.sends[0]!.idempotencyKey).toMatch(/^custom-prefix:/);
  });

  it("propagates correlationId when configured", async () => {
    const correlated = new NotificationChannelComplianceNotifier({
      channel,
      recipientEmail: "compliance@pharmax-operator.example",
      correlationId: "corr-123",
    });
    await correlated.notify(buildNotice());
    expect(channel.sends[0]!.correlationId).toBe("corr-123");
  });

  it("propagates channel send failures to the caller", async () => {
    const failing = new NotificationChannelComplianceNotifier({
      channel: makeChannel({ throwError: new Error("transport down") }),
      recipientEmail: "compliance@pharmax-operator.example",
    });
    await expect(failing.notify(buildNotice())).rejects.toThrow("transport down");
  });
});
