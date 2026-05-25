// Locks in the cross-cutting contracts of the error hierarchy:
//   - Each category maps to the right HTTP status.
//   - `category` correctly splits expected vs unexpected (the bus
//     uses this to decide whether to alert).
//   - `metadata` is frozen so handler code can't mutate audit data
//     after construction.
//   - `toJSON()` does NOT include `cause` or `stack` — both can chain
//     into PHI-adjacent payloads.
//   - `isPharmaxError` narrows correctly.

import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  InternalError,
  InvariantViolationError,
  NotFoundError,
  ValidationError,
  isPharmaxError,
} from "./index.js";

describe("error hierarchy", () => {
  it("maps each category to the correct HTTP status and operational category", () => {
    const cases = [
      {
        error: new ValidationError({ code: "X", message: "x" }),
        status: 400,
        category: "expected",
      },
      {
        error: new AuthenticationError({ code: "X", message: "x" }),
        status: 401,
        category: "expected",
      },
      {
        error: new AuthorizationError({ code: "X", message: "x" }),
        status: 403,
        category: "expected",
      },
      { error: new NotFoundError({ code: "X", message: "x" }), status: 404, category: "expected" },
      { error: new ConflictError({ code: "X", message: "x" }), status: 409, category: "expected" },
      {
        error: new InvariantViolationError({ code: "X", message: "x" }),
        status: 422,
        category: "expected",
      },
      {
        error: new InternalError({ code: "X", message: "x" }),
        status: 500,
        category: "unexpected",
      },
    ] as const;

    for (const { error, status, category } of cases) {
      expect(error.httpStatus).toBe(status);
      expect(error.category).toBe(category);
    }
  });

  it("freezes metadata so handlers cannot mutate audit context after construction", () => {
    const err = new ValidationError({
      code: "VAL_BAD_FIELD",
      message: "bad",
      metadata: { orderId: "ord_1" },
    });
    expect(Object.isFrozen(err.metadata)).toBe(true);
    expect(() => {
      (err.metadata as Record<string, unknown>)["leaked"] = "x";
    }).toThrowError(TypeError);
  });

  it("preserves the cause chain in the live object", () => {
    const root = new Error("root cause");
    const err = new InternalError({
      code: "INT_UNEXPECTED",
      message: "wrapping",
      cause: root,
    });
    expect(err.cause).toBe(root);
  });

  it("toJSON does NOT include cause or stack", () => {
    const root = new Error("root cause with potentially-PHI fields");
    const err = new InternalError({
      code: "INT_UNEXPECTED",
      message: "wrapping",
      cause: root,
      metadata: { context: "safe" },
    });
    const json = err.toJSON();
    expect(json).toEqual({
      name: "InternalError",
      code: "INT_UNEXPECTED",
      message: "wrapping",
      httpStatus: 500,
      metadata: { context: "safe" },
    });
    expect(JSON.stringify(json)).not.toContain("root cause");
    expect(JSON.stringify(json)).not.toContain("stack");
  });

  it("ValidationError.toJSON surfaces structured field issues", () => {
    const err = new ValidationError({
      code: "VAL_PARSE",
      message: "validation failed",
      issues: [
        { path: ["body", "quantity"], message: "Expected positive integer" },
        { path: ["body", "ndc"], message: "Required" },
      ],
    });
    const json = err.toJSON();
    expect(json.issues).toEqual([
      { path: ["body", "quantity"], message: "Expected positive integer" },
      { path: ["body", "ndc"], message: "Required" },
    ]);
  });

  it("isPharmaxError narrows correctly for own and foreign errors", () => {
    expect(isPharmaxError(new NotFoundError({ code: "X", message: "x" }))).toBe(true);
    expect(isPharmaxError(new Error("plain"))).toBe(false);
    expect(isPharmaxError("string")).toBe(false);
    expect(isPharmaxError(null)).toBe(false);
    expect(isPharmaxError(undefined)).toBe(false);
  });

  it("name is the subclass class name (used as a log/audit label)", () => {
    expect(new ValidationError({ code: "X", message: "x" }).name).toBe("ValidationError");
    expect(new AuthorizationError({ code: "X", message: "x" }).name).toBe("AuthorizationError");
    expect(new InvariantViolationError({ code: "X", message: "x" }).name).toBe(
      "InvariantViolationError"
    );
    expect(new InternalError({ code: "X", message: "x" }).name).toBe("InternalError");
  });

  it("subclasses are instanceof PharmaxError (so a single catch can handle all of ours)", () => {
    // Imported above; this just locks in the constructor chain.
    const errs = [
      new ValidationError({ code: "X", message: "x" }),
      new AuthorizationError({ code: "X", message: "x" }),
      new InternalError({ code: "X", message: "x" }),
    ];
    for (const err of errs) {
      expect(isPharmaxError(err)).toBe(true);
    }
  });
});
