// Route-level tests for the Resend delivery webhook.
//
// Svix verification + Prisma are mocked; the focus is the
// route's control flow: signature reject, missing-config 503,
// idempotent replay (P2002), unmappable-event NOOP, happy-path
// projection update, and the monotonic stale-event guard.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());

vi.mock("svix", () => {
  class WebhookVerificationError extends Error {}
  class Webhook {
    verify = verifyMock;
  }
  return { Webhook, WebhookVerificationError };
});

const prismaMock = vi.hoisted(() => ({
  resendWebhookEvent: { create: vi.fn(), update: vi.fn() },
  notificationDelivery: { findUnique: vi.fn(), update: vi.fn() },
}));

vi.mock("@pharmax/database", () => {
  // Mirror the real Prisma 5 constructor shape — second arg is an
  // options object `{ code, clientVersion, meta? }`, not a positional
  // code string — so the route's `cause.code === "P2002"` check and
  // the typechecker agree with the runtime mock.
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, options: { code: string; clientVersion?: string }) {
      super(message);
      this.code = options.code;
    }
  }
  return {
    prisma: prismaMock,
    Prisma: { PrismaClientKnownRequestError },
  };
});

vi.mock("@pharmax/tenancy", () => ({
  withSystemContext: (_label: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/server/env", () => ({
  env: { RESEND_WEBHOOK_SECRET: "whsec_test" },
}));

vi.mock("@/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { NextRequest } from "next/server";

import { Prisma } from "@pharmax/database";

import { POST } from "./route.js";

function buildRequest(headers: Record<string, string | null>): NextRequest {
  return {
    text: async () => "{}",
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
  } as unknown as NextRequest;
}

const VALID_HEADERS = {
  "svix-id": "msg_1",
  "svix-timestamp": "t",
  "svix-signature": "sig",
};

beforeEach(() => {
  verifyMock.mockReset();
  prismaMock.resendWebhookEvent.create.mockReset();
  prismaMock.resendWebhookEvent.update.mockReset();
  prismaMock.notificationDelivery.findUnique.mockReset();
  prismaMock.notificationDelivery.update.mockReset();
  prismaMock.resendWebhookEvent.update.mockResolvedValue({ id: "led-1" });
});

afterEach(() => vi.restoreAllMocks());

describe("Resend webhook route", () => {
  it("400s when svix headers are missing", async () => {
    const res = await POST(buildRequest({ "svix-id": null }));
    expect(res.status).toBe(400);
  });

  it("400s on signature verification failure", async () => {
    verifyMock.mockImplementation(() => {
      throw new (class extends Error {})();
    });
    // Force the thrown error to be recognized as a generic error
    // (not WebhookVerificationError) → invalid_payload path also 400.
    const res = await POST(buildRequest(VALID_HEADERS));
    expect(res.status).toBe(400);
  });

  it("acks 200 replay on duplicate svix-id (P2002)", async () => {
    verifyMock.mockReturnValue({
      type: "email.delivered",
      created_at: "2026-05-28T13:00:00.000Z",
      data: { email_id: "re_1" },
    });
    prismaMock.resendWebhookEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" })
    );
    const res = await POST(buildRequest(VALID_HEADERS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("replay");
  });

  it("NOOPs an unmappable event type", async () => {
    verifyMock.mockReturnValue({
      type: "email.quantum",
      created_at: "2026-05-28T13:00:00.000Z",
      data: { email_id: "re_1" },
    });
    prismaMock.resendWebhookEvent.create.mockResolvedValue({ id: "led-1" });
    const res = await POST(buildRequest(VALID_HEADERS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("noop_unknown_type");
    expect(prismaMock.notificationDelivery.update).not.toHaveBeenCalled();
  });

  it("applies a delivered event to the matching row", async () => {
    verifyMock.mockReturnValue({
      type: "email.delivered",
      created_at: "2026-05-28T13:00:00.000Z",
      data: { email_id: "re_1" },
    });
    prismaMock.resendWebhookEvent.create.mockResolvedValue({ id: "led-1" });
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({ id: "nd-1", lastEventAt: null });
    prismaMock.notificationDelivery.update.mockResolvedValue({ id: "nd-1" });

    const res = await POST(buildRequest(VALID_HEADERS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("applied");
    const updateArgs = prismaMock.notificationDelivery.update.mock.calls[0]![0] as {
      data: { status?: string; lastEventType: string };
    };
    expect(updateArgs.data.status).toBe("DELIVERED");
    expect(updateArgs.data.lastEventType).toBe("email.delivered");
  });

  it("NOOPs (no_row) when no delivery row matches the provider id", async () => {
    verifyMock.mockReturnValue({
      type: "email.delivered",
      created_at: "2026-05-28T13:00:00.000Z",
      data: { email_id: "re_unknown" },
    });
    prismaMock.resendWebhookEvent.create.mockResolvedValue({ id: "led-1" });
    prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
    const res = await POST(buildRequest(VALID_HEADERS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("noop_no_row");
  });

  it("drops a stale out-of-order event (monotonic guard)", async () => {
    verifyMock.mockReturnValue({
      type: "email.sent",
      created_at: "2026-05-28T12:00:00.000Z",
      data: { email_id: "re_1" },
    });
    prismaMock.resendWebhookEvent.create.mockResolvedValue({ id: "led-1" });
    prismaMock.notificationDelivery.findUnique.mockResolvedValue({
      id: "nd-1",
      lastEventAt: new Date("2026-05-28T13:00:00.000Z"),
    });
    const res = await POST(buildRequest(VALID_HEADERS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("noop_stale");
    expect(prismaMock.notificationDelivery.update).not.toHaveBeenCalled();
  });
});
