// Coverage for the audit error factories.
//
// The factories are 1-line constructors but they encode the
// operational contract this package exposes to the rest of the
// platform: which error class, which code, which metadata keys.
// A change to any of these is a contract break — these tests catch
// the change before it ships.
//
// They are intentionally trivial; the goal is to (a) lock the
// metadata shape, (b) prevent PHI from sneaking into the message,
// and (c) push the package's per-function coverage above the
// security-critical threshold.

import { describe, expect, it } from "vitest";

import {
  AUDIT_CHAIN_BROKEN,
  AUDIT_LOCK_UNAVAILABLE,
  AUDIT_NOT_IN_TRANSACTION,
  AUDIT_VALIDATION,
  auditChainBrokenError,
  auditLockUnavailableError,
  auditNotInTransactionError,
  auditValidationError,
} from "./errors.js";

describe("auditValidationError", () => {
  it("uses ValidationError with AUDIT_VALIDATION code and field/reason in the message", () => {
    const err = auditValidationError({ field: "action", reason: "must not be empty" });
    expect(err.code).toBe(AUDIT_VALIDATION);
    expect(err.message).toContain("action");
    expect(err.message).toContain("must not be empty");
    expect(err.issues).toEqual([{ path: ["action"], message: "must not be empty" }]);
  });
});

describe("auditChainBrokenError", () => {
  it("emits AUDIT_CHAIN_BROKEN with non-PHI metadata only", () => {
    const err = auditChainBrokenError({
      organizationId: "org-1",
      seq: 42n,
      reason: "hash-mismatch",
      expectedHashHex: "aa",
      actualHashHex: "bb",
    });
    expect(err.code).toBe(AUDIT_CHAIN_BROKEN);
    expect(err.message).toContain("42");
    expect(err.metadata).toEqual({
      organizationId: "org-1",
      seq: "42",
      reason: "hash-mismatch",
      expectedHashHex: "aa",
      actualHashHex: "bb",
    });
  });

  it("omits hash hex fields when not supplied (no `undefined` leakage)", () => {
    const err = auditChainBrokenError({
      organizationId: "org-1",
      seq: 1n,
      reason: "missing-row",
    });
    expect(err.metadata).toEqual({
      organizationId: "org-1",
      seq: "1",
      reason: "missing-row",
    });
    expect(err.metadata).not.toHaveProperty("expectedHashHex");
    expect(err.metadata).not.toHaveProperty("actualHashHex");
  });
});

describe("auditNotInTransactionError", () => {
  it("emits AUDIT_NOT_IN_TRANSACTION with explanatory message", () => {
    const err = auditNotInTransactionError();
    expect(err.code).toBe(AUDIT_NOT_IN_TRANSACTION);
    expect(err.message).toContain("transaction");
  });
});

describe("auditLockUnavailableError", () => {
  it("emits AUDIT_LOCK_UNAVAILABLE with organizationId metadata", () => {
    const err = auditLockUnavailableError({ organizationId: "org-1" });
    expect(err.code).toBe(AUDIT_LOCK_UNAVAILABLE);
    expect(err.metadata).toEqual({ organizationId: "org-1" });
  });
});
