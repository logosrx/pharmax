// Contract tests for
// POST /api/ops/orders/:orderId/acknowledge-pv1-screening-finding.
//
// `dispatchOpsCommand` owns the session, tenancy, idempotency and
// redirect machinery. What is specific to THIS route is that it carries
// exactly one fingerprint per request — there is no bulk form and the
// route must not grow one — that it refuses a submit with no
// fingerprint before a command is dispatched, and that a repeat says
// "already on record" rather than claiming a second judgement.

import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchOpsCommandMock = vi.hoisted(() => vi.fn());

vi.mock("@/server/ops/dispatch-from-route", () => ({
  dispatchOpsCommand: dispatchOpsCommandMock,
}));

vi.mock("@pharmax/verification", () => ({
  AcknowledgePV1ScreeningFinding: { name: "AcknowledgePV1ScreeningFinding" },
}));

import { POST } from "./route.js";

const ORDER_ID = "00000000-0000-4000-8000-0000000000aa";
const FINGERPRINT = "SCR_DRUG_INTERACTION|MAJOR/PROBABLE|INGREDIENT_ALFA+INGREDIENT_BRAVO";

interface CapturedConfig {
  readonly command: { readonly name: string };
  readonly buildInput: (input: {
    readonly body: FormData;
  }) => Record<string, unknown> | { readonly error: string };
  readonly successRedirect: (output: { readonly alreadyAcknowledged: boolean }) => string;
  readonly failureRedirect: string;
  readonly idempotencyKeyPrefix: string;
}

async function capture(): Promise<CapturedConfig> {
  await POST(
    new Request(`http://localhost/api/ops/orders/${ORDER_ID}/acknowledge-pv1-screening-finding`, {
      method: "POST",
    }),
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

describe("POST /api/ops/orders/:orderId/acknowledge-pv1-screening-finding", () => {
  it("dispatches AcknowledgePV1ScreeningFinding and nothing else", async () => {
    const config = await capture();
    expect(config.command.name).toBe("AcknowledgePV1ScreeningFinding");
    expect(config.idempotencyKeyPrefix).toBe(`route:acknowledge-pv1-screening-finding:${ORDER_ID}`);
  });

  it("sends the order from the path and the fingerprint from the body", async () => {
    const config = await capture();
    expect(config.buildInput({ body: formBody({ fingerprint: FINGERPRINT }) })).toEqual({
      orderId: ORDER_ID,
      fingerprint: FINGERPRINT,
    });
  });

  it("takes one fingerprint per request — a second value cannot ride along", async () => {
    const config = await capture();
    const body = formBody({ fingerprint: FINGERPRINT });
    body.append("fingerprint", "FP-SOMETHING-ELSE");
    const input = config.buildInput({ body }) as Record<string, unknown>;
    expect(input["fingerprint"]).toBe(FINGERPRINT);
    expect(Object.keys(input)).toEqual(["orderId", "fingerprint"]);
  });

  it("refuses a submit with no fingerprint before anything is recorded", async () => {
    const config = await capture();
    expect(config.buildInput({ body: formBody({}) })).toEqual({
      error: "fingerprint is required to acknowledge a screening finding.",
    });
    expect(config.buildInput({ body: formBody({ fingerprint: "" }) })).toHaveProperty("error");
  });

  it("lands back on the order, and distinguishes a repeat from a fresh judgement", async () => {
    const config = await capture();
    expect(config.successRedirect({ alreadyAcknowledged: false })).toBe(
      `/ops/orders/${ORDER_ID}?flash=screening_acknowledged`
    );
    expect(config.successRedirect({ alreadyAcknowledged: true })).toBe(
      `/ops/orders/${ORDER_ID}?flash=screening_already_acknowledged`
    );
    expect(config.failureRedirect).toBe(`/ops/orders/${ORDER_ID}`);
  });

  it("keeps the fingerprint out of every redirect URL", async () => {
    const config = await capture();
    for (const url of [
      config.successRedirect({ alreadyAcknowledged: false }),
      config.successRedirect({ alreadyAcknowledged: true }),
      config.failureRedirect,
    ]) {
      expect(url).not.toContain(FINGERPRINT);
      expect(url).not.toContain("INGREDIENT_ALFA");
    }
  });
});
