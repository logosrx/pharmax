// Contract tests for POST /api/ops/orders/:orderId/approve-pv1.
//
// `dispatchOpsCommand` owns session, tenancy, idempotency and redirect
// machinery. What is specific to THIS route is its two callers: the
// queue posts a bare approve, the order detail page posts `from=detail`
// plus the `reviewedScreenDigest` attestation. The route must thread
// the digest through untouched when it is well-formed, refuse it before
// dispatch when it is not, and send a failure back to whichever surface
// posted — the detail page's refusal banner sits beside the findings
// panel it is about, the queue's banner links to it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchOpsCommandMock = vi.hoisted(() => vi.fn());

vi.mock("@/server/ops/dispatch-from-route", () => ({
  dispatchOpsCommand: dispatchOpsCommandMock,
}));

vi.mock("@pharmax/verification", () => ({
  ApprovePV1: { name: "ApprovePV1" },
  SCREEN_DIGEST_PATTERN: /^[0-9a-f]{64}$/,
}));

import { POST } from "./route.js";

const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const DIGEST = "0f".repeat(32);

interface CapturedConfig {
  readonly command: { readonly name: string };
  readonly buildInput: (input: {
    readonly body: FormData;
  }) => Record<string, unknown> | { readonly error: string };
  readonly successRedirect: (output: unknown) => string;
  readonly failureRedirect: () => string;
  readonly idempotencyKeyPrefix: string;
}

async function capture(): Promise<CapturedConfig> {
  await POST(
    new Request(`http://localhost/api/ops/orders/${ORDER_ID}/approve-pv1`, { method: "POST" }),
    { params: Promise.resolve({ orderId: ORDER_ID }) }
  );
  return dispatchOpsCommandMock.mock.calls[0]?.[0] as CapturedConfig;
}

function formBody(fields: Readonly<Record<string, string>>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

beforeEach(() => {
  dispatchOpsCommandMock.mockReset().mockResolvedValue(new Response(null, { status: 303 }));
});

describe("POST /api/ops/orders/:orderId/approve-pv1", () => {
  it("dispatches ApprovePV1 and nothing else", async () => {
    const config = await capture();
    expect(config.command.name).toBe("ApprovePV1");
    expect(config.idempotencyKeyPrefix).toBe(`route:approve-pv1:${ORDER_ID}`);
  });

  it("a bare queue approve sends the order id alone — no digest field rides along", async () => {
    const config = await capture();
    expect(config.buildInput({ body: formBody({}) })).toEqual({ orderId: ORDER_ID });
  });

  it("threads a well-formed reviewedScreenDigest through untouched", async () => {
    const config = await capture();
    expect(config.buildInput({ body: formBody({ reviewedScreenDigest: DIGEST }) })).toEqual({
      orderId: ORDER_ID,
      reviewedScreenDigest: DIGEST,
    });
  });

  it("refuses a malformed digest before a command is dispatched", async () => {
    const config = await capture();
    for (const bad of ["nope", "0F".repeat(32), DIGEST + "00", DIGEST.slice(0, 63)]) {
      expect(config.buildInput({ body: formBody({ reviewedScreenDigest: bad }) })).toEqual({
        error: "reviewedScreenDigest must be a hex SHA-256 digest.",
      });
    }
  });

  it("success lands on the queue with the approved order named, from either surface", async () => {
    const config = await capture();
    config.buildInput({ body: formBody({ from: "detail", reviewedScreenDigest: DIGEST }) });
    expect(config.successRedirect({})).toBe(`/ops/pv1?flash=approved&orderId=${ORDER_ID}`);
  });

  it("a failure returns to the surface that posted: queue by default, detail when from=detail", async () => {
    const queueConfig = await capture();
    queueConfig.buildInput({ body: formBody({}) });
    expect(queueConfig.failureRedirect()).toBe(`/ops/pv1?orderId=${ORDER_ID}`);

    dispatchOpsCommandMock.mockClear();
    const detailConfig = await capture();
    detailConfig.buildInput({ body: formBody({ from: "detail", reviewedScreenDigest: DIGEST }) });
    expect(detailConfig.failureRedirect()).toBe(`/ops/orders/${ORDER_ID}`);
  });

  it("an unrecognized `from` value falls back to the queue target", async () => {
    const config = await capture();
    config.buildInput({ body: formBody({ from: "somewhere-else" }) });
    expect(config.failureRedirect()).toBe(`/ops/pv1?orderId=${ORDER_ID}`);
  });
});
