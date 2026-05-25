import { describe, expect, it } from "vitest";

import { REDACT_CENSOR, redactPayload } from "./redact.js";

describe("redactPayload", () => {
  it("returns empty object for null/undefined", () => {
    expect(redactPayload(null)).toEqual({});
    expect(redactPayload(undefined)).toEqual({});
  });

  it("wraps non-objects as { value }", () => {
    expect(redactPayload("hello")).toEqual({ value: "hello" });
    expect(redactPayload(42)).toEqual({ value: 42 });
    expect(redactPayload([1, 2, 3])).toEqual({ value: [1, 2, 3] });
  });

  it("redacts the always-redact set even with no declared fields", () => {
    expect(redactPayload({ password: "hunter2", username: "alice" })).toEqual({
      password: REDACT_CENSOR,
      username: "alice",
    });
  });

  it("redacts declared fields in addition to the always set", () => {
    expect(redactPayload({ ssn: "x", email: "a@b.test", note: "ok" }, ["email"])).toEqual({
      ssn: REDACT_CENSOR,
      email: REDACT_CENSOR,
      note: "ok",
    });
  });

  it("does NOT mutate the caller's object", () => {
    const original = { password: "hunter2", username: "alice" };
    redactPayload(original);
    expect(original).toEqual({ password: "hunter2", username: "alice" });
  });

  it("redacts standard PHI-adjacent keys", () => {
    const out = redactPayload({
      ssn: "123-45-6789",
      dob: "1990-01-01",
      dateOfBirth: "1990-01-01",
      mrn: "MRN-001",
      stripeSignature: "sig",
      authorization: "Bearer x",
      cookie: "sid=abc",
      keep: "yes",
    });
    expect(out["keep"]).toBe("yes");
    for (const k of [
      "ssn",
      "dob",
      "dateOfBirth",
      "mrn",
      "stripeSignature",
      "authorization",
      "cookie",
    ]) {
      expect(out[k]).toBe(REDACT_CENSOR);
    }
  });
});
