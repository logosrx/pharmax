// Contract tests for POST /api/ops/orders/:orderId/reject-pv1.
//
// What is specific to THIS route: the reason code is validated against
// the closed `PV1_REJECTION_REASONS` vocabulary before a command is
// dispatched (every rejection requires a reason code — workflow safety
// rule, enforced again by the command's schema), and a failure returns
// to whichever surface posted — the queue by default, the order detail
// page when the form says `from=detail`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchOpsCommandMock = vi.hoisted(() => vi.fn());

vi.mock("@/server/ops/dispatch-from-route", () => ({
  dispatchOpsCommand: dispatchOpsCommandMock,
}));

vi.mock("@pharmax/verification", () => ({
  RejectPV1: { name: "RejectPV1" },
  PV1_REJECTION_REASONS: ["DOSE_INCORRECT", "DRUG_INTERACTION", "OTHER_CLINICAL"],
}));

import { POST } from "./route.js";

const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";

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
    new Request(`http://localhost/api/ops/orders/${ORDER_ID}/reject-pv1`, { method: "POST" }),
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

describe("POST /api/ops/orders/:orderId/reject-pv1", () => {
  it("dispatches RejectPV1 and nothing else", async () => {
    const config = await capture();
    expect(config.command.name).toBe("RejectPV1");
    expect(config.idempotencyKeyPrefix).toBe(`route:reject-pv1:${ORDER_ID}`);
  });

  it("sends the order from the path and the reason from the body", async () => {
    const config = await capture();
    expect(config.buildInput({ body: formBody({ reasonCode: "DOSE_INCORRECT" }) })).toEqual({
      orderId: ORDER_ID,
      reasonCode: "DOSE_INCORRECT",
    });
  });

  it("refuses a missing or unknown reason before a command is dispatched", async () => {
    const config = await capture();
    expect(config.buildInput({ body: formBody({}) })).toHaveProperty("error");
    expect(config.buildInput({ body: formBody({ reasonCode: "NOT_A_REASON" }) })).toHaveProperty(
      "error"
    );
  });

  it("success lands on the queue with the rejected order named", async () => {
    const config = await capture();
    config.buildInput({ body: formBody({ reasonCode: "DOSE_INCORRECT" }) });
    expect(config.successRedirect({})).toBe(`/ops/pv1?flash=rejected&orderId=${ORDER_ID}`);
  });

  it("a failure returns to the surface that posted: queue by default, detail when from=detail", async () => {
    const queueConfig = await capture();
    queueConfig.buildInput({ body: formBody({ reasonCode: "DOSE_INCORRECT" }) });
    expect(queueConfig.failureRedirect()).toBe(`/ops/pv1`);

    dispatchOpsCommandMock.mockClear();
    const detailConfig = await capture();
    detailConfig.buildInput({
      body: formBody({ from: "detail", reasonCode: "DOSE_INCORRECT" }),
    });
    expect(detailConfig.failureRedirect()).toBe(`/ops/orders/${ORDER_ID}`);
  });

  it("resolves the failure surface even when the reason is refused — the error lands where the form was", async () => {
    const config = await capture();
    const result = config.buildInput({ body: formBody({ from: "detail" }) });
    expect(result).toHaveProperty("error");
    expect(config.failureRedirect()).toBe(`/ops/orders/${ORDER_ID}`);
  });
});
