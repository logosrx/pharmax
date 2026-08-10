// Contract tests for the ops request-body guard, exercised with real
// Request objects — the point of the module is what fetch-spec body
// parsing does with hostile input, so mocking the parsing would test
// nothing.
//
// The regression this pins: `request.formData()` throws on any body
// that is not form-encoded or multipart, and before this guard every
// ops action route reached it unprotected — a `text/plain` POST (or a
// curl with no content type) produced an unhandled 500 instead of the
// flash-redirect contract every other failure on these routes honours.

import { describe, expect, it } from "vitest";

import { OPS_REQUEST_BODY_INVALID, parseOpsRequestBody } from "./parse-request-body.js";

const URL_ = "http://localhost/api/ops/orders/o-1/approve-pv1";

describe("parseOpsRequestBody — form bodies", () => {
  it("parses a urlencoded form POST (what browser forms send)", async () => {
    const result = await parseOpsRequestBody(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ reasonCode: "DOSE_INCORRECT" }),
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyKind).toBe("form");
    expect((result.body as FormData).get("reasonCode")).toBe("DOSE_INCORRECT");
  });

  it("parses a multipart form POST", async () => {
    const form = new FormData();
    form.set("field", "value");
    const result = await parseOpsRequestBody(new Request(URL_, { method: "POST", body: form }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyKind).toBe("form");
    expect((result.body as FormData).get("field")).toBe("value");
  });
});

describe("parseOpsRequestBody — JSON bodies", () => {
  it("parses valid JSON when the content type says JSON", async () => {
    const result = await parseOpsRequestBody(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disposition: "RESOLVED" }),
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyKind).toBe("json");
    expect(result.body).toEqual({ disposition: "RESOLVED" });
  });

  it("degrades malformed JSON to an empty record (field validation reports the miss)", async () => {
    const result = await parseOpsRequestBody(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      })
    );
    expect(result).toMatchObject({ ok: true, bodyKind: "json", body: {} });
  });
});

describe("parseOpsRequestBody — bodies that used to 500", () => {
  const hostile: ReadonlyArray<readonly [string, RequestInit]> = [
    [
      "a text/plain POST",
      { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" },
    ],
    ["a POST with a body but no content type", { method: "POST", body: "raw bytes" }],
    [
      "an XML body",
      { method: "POST", headers: { "content-type": "application/xml" }, body: "<a/>" },
    ],
    [
      "a claimed-multipart body with no boundary",
      { method: "POST", headers: { "content-type": "multipart/form-data" }, body: "x" },
    ],
  ];

  for (const [label, init] of hostile) {
    it(`refuses ${label} with a flash-ready error instead of throwing`, async () => {
      const result = await parseOpsRequestBody(new Request(URL_, init));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain(OPS_REQUEST_BODY_INVALID);
      // The refusal must never echo the body back into a URL.
      expect(result.error).not.toContain("hello");
      expect(result.error).not.toContain("raw bytes");
    });
  }

  it("a bodyless POST with no content type is also a clean refusal", async () => {
    const result = await parseOpsRequestBody(new Request(URL_, { method: "POST" }));
    expect(result.ok).toBe(false);
  });
});
