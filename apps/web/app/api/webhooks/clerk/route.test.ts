// Transport-layer tests for the Clerk webhook receiver.
//
// What the route owns (and what we exercise here):
//   - Reading the raw bytes (Svix signs raw bytes; if we parsed the
//     body to JSON before verifying we'd silently accept any payload).
//   - Header presence (svix-id / svix-timestamp / svix-signature).
//   - Signature verification via the injected `svix.Webhook`.
//   - Idempotency through the `clerk_webhook_event` ledger
//     (unique-on-`svixMessageId`, with PENDING-retry semantics for
//     receivers that crashed mid-tx).
//   - Status-code shaping: 503 on misconfig, 400 on bad input,
//     500 on dispatcher failure (Clerk retries on 5xx), 200 on
//     applied / noop / replay.
//
// What lives in `clerk-webhook-handlers.test.ts` (NOT here):
//   - Per-event-type business logic (link, sync, terminate,
//     session audit).
//
// Mocking strategy:
//   - `svix` is fully mocked: `Webhook.verify` returns the parsed
//     event by default, and we override per-test to simulate a bad
//     signature. The real signature math is upstream; we trust it.
//   - `@pharmax/database` is mocked with a hand-rolled fake that
//     supports the three methods the route calls AND exports a
//     `Prisma` namespace carrying a `PrismaClientKnownRequestError`
//     class — the route's `isUniqueViolation` uses `instanceof` on
//     it.
//   - The dispatcher (`dispatchClerkWebhookEvent`) is mocked so we
//     can drive each outcome ("applied" / "noop_*" / throw) without
//     re-stubbing Prisma per branch.
//   - The env module is mocked to control `CLERK_WEBHOOK_SECRET`.
//   - The logger is left untouched — vitest captures stdout and
//     these log lines are intentional observability for the receipt.
//
// Test data convention: synthetic identifiers only — no real
// patient or operator data, per .cursor/rules/02-security-compliance.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks. MUST be declared BEFORE the dynamic import of the
// route module so vi can swap the resolutions at module-load time.
// ---------------------------------------------------------------------------

const verifyMock = vi.fn();
class FakeWebhook {
  public constructor(_secret: string) {
    /* secret captured by tests via the env mock; never read here */
  }
  public verify(...args: unknown[]): unknown {
    return verifyMock(...args);
  }
}
class FakeWebhookVerificationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
vi.mock("svix", () => ({
  Webhook: FakeWebhook,
  WebhookVerificationError: FakeWebhookVerificationError,
}));

class FakePrismaClientKnownRequestError extends Error {
  public readonly code: string;
  public constructor(message: string, opts: { readonly code: string }) {
    super(message);
    this.code = opts.code;
    this.name = "PrismaClientKnownRequestError";
  }
}
const prismaMock = {
  clerkWebhookEvent: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};
vi.mock("@pharmax/database", () => ({
  prisma: prismaMock,
  Prisma: {
    PrismaClientKnownRequestError: FakePrismaClientKnownRequestError,
  },
}));

const dispatchMock = vi.fn();
vi.mock("@/server/auth/clerk-webhook-handlers", () => ({
  dispatchClerkWebhookEvent: dispatchMock,
}));

const envMock: { CLERK_WEBHOOK_SECRET: string | undefined } = {
  CLERK_WEBHOOK_SECRET: "whsec_test_secret_synthetic",
};
vi.mock("@/server/env", () => ({
  // The route reads `env.CLERK_WEBHOOK_SECRET` as a plain property
  // access; a getter lets each test flip the value without re-importing.
  env: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === "CLERK_WEBHOOK_SECRET") return envMock.CLERK_WEBHOOK_SECRET;
      return undefined;
    },
  }),
}));

// ---------------------------------------------------------------------------
// Route import — AFTER mocks.
// ---------------------------------------------------------------------------

const { POST, GET } = await import("./route.js");

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const SVIX_ID = "msg_2webhookTEST";
const SVIX_TIMESTAMP = "1700000000";
const SVIX_SIGNATURE = "v1,fake_signature_synthetic";

function makeRequest(
  body: string,
  overrides: { readonly headers?: Record<string, string> } = {}
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "svix-id": SVIX_ID,
    "svix-timestamp": SVIX_TIMESTAMP,
    "svix-signature": SVIX_SIGNATURE,
    ...(overrides.headers ?? {}),
  };
  return new Request("http://internal/api/webhooks/clerk", {
    method: "POST",
    headers,
    body,
  });
}

const VALID_EVENT = {
  type: "user.created",
  data: {
    id: "clerk_user_2synthRoute",
    primary_email_address_id: "idn_primary",
    email_addresses: [{ id: "idn_primary", email_address: "operator@acme.test" }],
    first_name: "Op",
    last_name: "Erator",
    username: null,
  },
};

beforeEach(() => {
  envMock.CLERK_WEBHOOK_SECRET = "whsec_test_secret_synthetic";
  verifyMock.mockReset();
  verifyMock.mockReturnValue(VALID_EVENT);
  prismaMock.clerkWebhookEvent.create.mockReset();
  prismaMock.clerkWebhookEvent.findUnique.mockReset();
  prismaMock.clerkWebhookEvent.update.mockReset();
  prismaMock.clerkWebhookEvent.create.mockResolvedValue({ id: "ledger_row_id" });
  prismaMock.clerkWebhookEvent.update.mockResolvedValue({});
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue("applied");
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 503 — secret not configured.
// ---------------------------------------------------------------------------

describe("POST /api/webhooks/clerk — configuration gate", () => {
  it("returns 503 when CLERK_WEBHOOK_SECRET is unset (does NOT call svix or Prisma)", async () => {
    envMock.CLERK_WEBHOOK_SECRET = undefined;
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("clerk_webhook_not_configured");
    expect(verifyMock).not.toHaveBeenCalled();
    expect(prismaMock.clerkWebhookEvent.create).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 400 — missing required headers.
// ---------------------------------------------------------------------------

describe("POST /api/webhooks/clerk — missing required headers", () => {
  it("rejects with 400 when svix-id is missing", async () => {
    const request = new Request("http://internal/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-timestamp": SVIX_TIMESTAMP,
        "svix-signature": SVIX_SIGNATURE,
      },
      body: JSON.stringify(VALID_EVENT),
    });
    const response = await POST(request as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("invalid_signature");
    expect(verifyMock).not.toHaveBeenCalled();
    expect(prismaMock.clerkWebhookEvent.create).not.toHaveBeenCalled();
  });

  it("rejects with 400 when svix-timestamp is missing", async () => {
    const request = new Request("http://internal/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": SVIX_ID,
        "svix-signature": SVIX_SIGNATURE,
      },
      body: JSON.stringify(VALID_EVENT),
    });
    const response = await POST(request as never);
    expect(response.status).toBe(400);
  });

  it("rejects with 400 when svix-signature is missing", async () => {
    const request = new Request("http://internal/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": SVIX_ID,
        "svix-timestamp": SVIX_TIMESTAMP,
      },
      body: JSON.stringify(VALID_EVENT),
    });
    const response = await POST(request as never);
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 400 — bad signature.
// ---------------------------------------------------------------------------

describe("POST /api/webhooks/clerk — invalid signature", () => {
  it("rejects with 400 when svix.verify throws WebhookVerificationError", async () => {
    verifyMock.mockImplementationOnce(() => {
      throw new FakeWebhookVerificationError("bad signature");
    });
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("invalid_signature");
    // Ledger not touched on rejection — the receipt is unauthenticated.
    expect(prismaMock.clerkWebhookEvent.create).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("rejects with 400 when svix.verify throws an unrelated error (defensive)", async () => {
    verifyMock.mockImplementationOnce(() => {
      throw new Error("svix internal crash");
    });
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("invalid_signature");
  });

  it("verifies against the RAW request body (not the parsed JSON)", async () => {
    // The receiver MUST hand svix the raw bytes — if it parsed first
    // and re-stringified, the signature would not match. Drive a body
    // with deterministic whitespace and assert verify saw it verbatim.
    const rawBody = '{"type":"user.created","data":{"id":"clerk_user_synth"}}';
    verifyMock.mockImplementationOnce((seenBody: string) => {
      expect(seenBody).toBe(rawBody);
      return VALID_EVENT;
    });
    const response = await POST(makeRequest(rawBody) as never);
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 400 — invalid payload shape (verified, but not a Clerk event).
// ---------------------------------------------------------------------------

describe("POST /api/webhooks/clerk — invalid payload shape", () => {
  it("rejects with 400 when the verified payload lacks `type`", async () => {
    verifyMock.mockReturnValueOnce({ data: { some: "thing" } });
    const response = await POST(makeRequest('{"data":{"some":"thing"}}') as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("invalid_payload");
    expect(prismaMock.clerkWebhookEvent.create).not.toHaveBeenCalled();
  });

  it("rejects with 400 when the verified payload is not an object", async () => {
    verifyMock.mockReturnValueOnce("not_an_object");
    const response = await POST(makeRequest('"not_an_object"') as never);
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 200 — happy path: applied + ledger written.
// ---------------------------------------------------------------------------

describe("POST /api/webhooks/clerk — happy path", () => {
  it("inserts a PENDING ledger row, dispatches, then updates to APPLIED on success", async () => {
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; eventType: string };
    expect(body.status).toBe("applied");
    expect(body.eventType).toBe("user.created");

    expect(prismaMock.clerkWebhookEvent.create).toHaveBeenCalledTimes(1);
    const createCall = prismaMock.clerkWebhookEvent.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data.svixMessageId).toBe(SVIX_ID);
    expect(createCall.data.eventType).toBe("user.created");
    expect(createCall.data.status).toBe("PENDING");

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect((dispatchMock.mock.calls[0]?.[0] as { type: string }).type).toBe("user.created");

    expect(prismaMock.clerkWebhookEvent.update).toHaveBeenCalledTimes(1);
    const updateCall = prismaMock.clerkWebhookEvent.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateCall.where.id).toBe("ledger_row_id");
    expect(updateCall.data.status).toBe("APPLIED");
    expect(updateCall.data.dispatchOutcome).toBe("applied");
  });

  it("returns 200 with the dispatcher's noop outcome (status mapped to NOOP in ledger)", async () => {
    dispatchMock.mockResolvedValueOnce("noop_no_invited_row");
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("noop_no_invited_row");
    const updateCall = prismaMock.clerkWebhookEvent.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data.status).toBe("NOOP");
    expect(updateCall.data.dispatchOutcome).toBe("noop_no_invited_row");
  });

  it("returns 200 with noop_unknown_event for an unhandled Clerk event type (NEVER 4xx)", async () => {
    // Per ADR-0025 contract: Clerk retries forever on 4xx/5xx. An
    // unknown event type MUST ack 200 so the queue drains.
    verifyMock.mockReturnValueOnce({ type: "organization.created", data: {} });
    dispatchMock.mockResolvedValueOnce("noop_unknown_event");
    const response = await POST(makeRequest('{"type":"organization.created","data":{}}') as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("noop_unknown_event");
  });
});

// ---------------------------------------------------------------------------
// Idempotency — replay handling.
// ---------------------------------------------------------------------------

describe("POST /api/webhooks/clerk — idempotency", () => {
  it("acks 200 with status=replay when the ledger row already has a terminal status", async () => {
    prismaMock.clerkWebhookEvent.create.mockRejectedValueOnce(
      new FakePrismaClientKnownRequestError("unique violation", { code: "P2002" })
    );
    prismaMock.clerkWebhookEvent.findUnique.mockResolvedValueOnce({
      id: "ledger_row_id",
      status: "APPLIED",
      dispatchOutcome: "applied",
      attempts: 1,
    });
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      eventType: string;
      previousOutcome: string;
    };
    expect(body.status).toBe("replay");
    expect(body.eventType).toBe("user.created");
    expect(body.previousOutcome).toBe("applied");
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(prismaMock.clerkWebhookEvent.update).not.toHaveBeenCalled();
  });

  it("re-dispatches when the existing ledger row is PENDING (crashed mid-tx recovery)", async () => {
    prismaMock.clerkWebhookEvent.create.mockRejectedValueOnce(
      new FakePrismaClientKnownRequestError("unique violation", { code: "P2002" })
    );
    prismaMock.clerkWebhookEvent.findUnique.mockResolvedValueOnce({
      id: "existing_pending_ledger",
      status: "PENDING",
      dispatchOutcome: null,
      attempts: 0,
    });
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    // Updates the PRE-EXISTING row, not a new one.
    expect(prismaMock.clerkWebhookEvent.update).toHaveBeenCalledTimes(1);
    const updateCall = prismaMock.clerkWebhookEvent.update.mock.calls[0]?.[0] as {
      where: { id: string };
    };
    expect(updateCall.where.id).toBe("existing_pending_ledger");
  });

  it("returns 500 when the unique-violation lookup fails to find the row (race)", async () => {
    prismaMock.clerkWebhookEvent.create.mockRejectedValueOnce(
      new FakePrismaClientKnownRequestError("unique violation", { code: "P2002" })
    );
    prismaMock.clerkWebhookEvent.findUnique.mockResolvedValueOnce(null);
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("dispatch_failed");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("returns 500 when the ledger INSERT fails with a non-unique error", async () => {
    prismaMock.clerkWebhookEvent.create.mockRejectedValueOnce(new Error("connection terminated"));
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("dispatch_failed");
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 500 — dispatcher failure (Clerk retries on 5xx).
// ---------------------------------------------------------------------------

describe("POST /api/webhooks/clerk — dispatcher failure", () => {
  it("returns 500 and marks the ledger row FAILED when the dispatcher throws", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("handler boom"));
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("dispatch_failed");

    expect(prismaMock.clerkWebhookEvent.update).toHaveBeenCalledTimes(1);
    const updateCall = prismaMock.clerkWebhookEvent.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data.status).toBe("FAILED");
    expect(updateCall.data.lastError).toBe("handler boom");
  });

  it("still returns 500 if the post-failure ledger update ALSO fails (observability only)", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("handler boom"));
    prismaMock.clerkWebhookEvent.update.mockRejectedValueOnce(new Error("ledger update boom"));
    const response = await POST(makeRequest(JSON.stringify(VALID_EVENT)) as never);
    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET — method-not-allowed.
// ---------------------------------------------------------------------------

describe("GET /api/webhooks/clerk", () => {
  it("returns 405 with an Allow: POST header", () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
});
