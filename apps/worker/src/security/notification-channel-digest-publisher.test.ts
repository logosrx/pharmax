// Unit coverage for NotificationChannelDigestPublisher.
//
// We assert ONLY the adapter's responsibilities — context shape,
// idempotency key, recipient pinning, error propagation. The actual
// rendering lives in render-security-digest-email.ts and has its
// own focused tests; the PHI sentinel gate + required-key gate live
// in @pharmax/notifications and have their own tests there.

import {
  type NotificationChannel,
  type NotificationChannelMetadata,
  type NotificationSendInput,
  type NotificationSendResult,
} from "@pharmax/notifications";
import { type SecurityDigest } from "@pharmax/security";
import { beforeEach, describe, expect, it } from "vitest";

import { NotificationChannelDigestPublisher } from "./notification-channel-digest-publisher.js";

function buildDigest(overrides?: Partial<SecurityDigest>): SecurityDigest {
  return {
    generatedAt: "2026-06-02T06:30:00.000Z",
    windowStart: "2026-06-01T06:30:00.000Z",
    windowEnd: "2026-06-02T06:30:00.000Z",
    auditChainStatuses: [
      { organizationId: "org_a", valid: true, verifiedRows: 100, lastSeq: "100" },
      { organizationId: "org_b", valid: true, verifiedRows: 50, lastSeq: "50" },
    ],
    breakGlassSessions: [],
    failedLoginSpikes: [],
    outboxStatuses: [],
    sentryStatus: { project: "pharmacy-worker", errorCount: 0, windowHours: 24 },
    accessReviewsDue: [],
    ...overrides,
  } as SecurityDigest;
}

interface FakeChannel extends NotificationChannel {
  readonly sends: ReadonlyArray<NotificationSendInput>;
}

function makeChannel(opts?: {
  readonly result?: NotificationSendResult;
  readonly throwError?: Error;
  readonly metadataName?: string;
}): FakeChannel {
  const sends: NotificationSendInput[] = [];
  const metadata: NotificationChannelMetadata = Object.freeze({
    name: opts?.metadataName ?? "fake-channel",
    supportedRecipientKinds: Object.freeze(["email"]) as ReadonlyArray<"email">,
    phiCapable: false,
  });
  const channel: FakeChannel = {
    metadata,
    sends,
    async send(input: NotificationSendInput): Promise<NotificationSendResult> {
      sends.push(input);
      if (opts?.throwError) throw opts.throwError;
      return (
        opts?.result ??
        Object.freeze({
          deliveryId: "msg_test_001",
          status: "delivered" as const,
          recipientKind: "email" as const,
          sentAt: new Date("2026-06-02T06:30:01.000Z"),
        })
      );
    },
  };
  return channel;
}

describe("NotificationChannelDigestPublisher — construction", () => {
  it("throws when recipientEmail is empty", () => {
    expect(
      () =>
        new NotificationChannelDigestPublisher({
          channel: makeChannel(),
          recipientEmail: "",
        })
    ).toThrow(/recipientEmail/);
  });

  it("throws when recipientEmail is whitespace-only", () => {
    expect(
      () =>
        new NotificationChannelDigestPublisher({
          channel: makeChannel(),
          recipientEmail: "   ",
        })
    ).toThrow(/recipientEmail/);
  });
});

describe("NotificationChannelDigestPublisher — publish", () => {
  let channel: FakeChannel;
  let publisher: NotificationChannelDigestPublisher;

  beforeEach(() => {
    channel = makeChannel();
    publisher = new NotificationChannelDigestPublisher({
      channel,
      recipientEmail: "security@pharmax.test",
    });
  });

  it("dispatches the SECURITY_DIGEST_DAILY_V1 template", async () => {
    await publisher.publish(buildDigest(), "rendered body\n");
    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]!.template).toBe("SECURITY_DIGEST_DAILY_V1");
  });

  it("pins the recipient as the configured email address with kind=email", async () => {
    await publisher.publish(buildDigest(), "rendered body\n");
    expect(channel.sends[0]!.to).toEqual({
      kind: "email",
      address: "security@pharmax.test",
    });
  });

  it("builds an idempotency key keyed off the digest's generatedAt timestamp", async () => {
    await publisher.publish(buildDigest(), "rendered body\n");
    expect(channel.sends[0]!.idempotencyKey).toBe("security-digest:2026-06-02T06:30:00.000Z");
  });

  it("two publishes of the same digest yield the SAME idempotency key (dedupe at vendor)", async () => {
    const digest = buildDigest();
    await publisher.publish(digest, "body 1");
    await publisher.publish(digest, "body 2");
    expect(channel.sends[0]!.idempotencyKey).toBe(channel.sends[1]!.idempotencyKey);
  });

  it("two publishes of DIFFERENT digests (different generatedAt) yield DIFFERENT idempotency keys", async () => {
    await publisher.publish(buildDigest({ generatedAt: "2026-06-02T06:30:00.000Z" }), "x");
    await publisher.publish(buildDigest({ generatedAt: "2026-06-03T06:30:00.000Z" }), "y");
    expect(channel.sends[0]!.idempotencyKey).not.toBe(channel.sends[1]!.idempotencyKey);
  });

  it("honors a custom idempotencyKeyPrefix", async () => {
    const customPublisher = new NotificationChannelDigestPublisher({
      channel,
      recipientEmail: "security@pharmax.test",
      idempotencyKeyPrefix: "weekly-digest-v2",
    });
    await customPublisher.publish(buildDigest(), "body");
    expect(channel.sends[0]!.idempotencyKey).toBe("weekly-digest-v2:2026-06-02T06:30:00.000Z");
  });

  it("propagates the optional correlationId through to the channel send", async () => {
    const tracedPublisher = new NotificationChannelDigestPublisher({
      channel,
      recipientEmail: "security@pharmax.test",
      correlationId: "trace_abc",
    });
    await tracedPublisher.publish(buildDigest(), "body");
    expect(channel.sends[0]!.correlationId).toBe("trace_abc");
  });

  it("does NOT thread an organizationId — the digest is cross-org, persistence ledger skips intentionally", async () => {
    await publisher.publish(buildDigest(), "body");
    expect(channel.sends[0]!.organizationId).toBeUndefined();
  });

  it("composes the full required-context payload (every key required by the template)", async () => {
    const digest = buildDigest({
      auditChainStatuses: [
        { organizationId: "a", valid: true, verifiedRows: 1, lastSeq: "1" },
        { organizationId: "b", valid: false, reason: "seq gap", seq: "42" },
        { organizationId: "c", valid: false, reason: "hash mismatch", seq: "99" },
      ],
      breakGlassSessions: [
        {
          sessionId: "s1",
          requestedByUserId: "u1",
          approvedByUserId: "u2",
          ticketUrl: "https://t.test/1",
          openedAt: "2026-06-02T01:00:00.000Z",
          closedAt: null,
          actionCount: 7,
        },
      ],
      outboxStatuses: [
        { organizationId: "a", deadCount: 2 },
        { organizationId: "b", deadCount: 5 },
      ],
    });
    await publisher.publish(digest, "rendered body");
    const ctx = channel.sends[0]!.context;
    expect(ctx).toMatchObject({
      generatedAtIso: digest.generatedAt,
      windowFromIso: digest.windowStart,
      windowToIso: digest.windowEnd,
      digestText: "rendered body",
      auditOrgCount: 3,
      brokenChainCount: 2,
      breakGlassCount: 1,
      outboxDeadCount: 2,
    });
  });

  it("returns the channel's deliveryId as the transportId", async () => {
    channel = makeChannel({
      result: {
        deliveryId: "msg_resend_abc123",
        status: "delivered",
        recipientKind: "email",
        sentAt: new Date(),
      },
    });
    publisher = new NotificationChannelDigestPublisher({
      channel,
      recipientEmail: "security@pharmax.test",
    });
    const result = await publisher.publish(buildDigest(), "body");
    expect(result).toEqual({ transportId: "msg_resend_abc123" });
  });

  it("propagates channel send errors unchanged so the loop's catch can log + alarm", async () => {
    const cause = new Error("Resend transport failed");
    channel = makeChannel({ throwError: cause });
    publisher = new NotificationChannelDigestPublisher({
      channel,
      recipientEmail: "security@pharmax.test",
    });
    await expect(publisher.publish(buildDigest(), "body")).rejects.toBe(cause);
  });
});
