// Gate-level tests for the free-text → append-only-ledger boundary.
// Session-level integration (open/runAs/close refusals) is covered in
// break-glass-session.test.ts; these tests pin the gate's own
// contract: the closed code list, the compose format, the bounds,
// and — critically — that no refusal message ever quotes the text it
// refused.

import { describe, expect, it } from "vitest";

import {
  BREAK_GLASS_LEDGER_TEXT_REJECTED,
  BREAK_GLASS_LEDGER_TEXT_TOO_LONG,
  BREAK_GLASS_SESSION_DETAIL_REQUIRED,
  BREAK_GLASS_SESSION_REASON_REQUIRED,
} from "./errors.js";
import {
  BREAK_GLASS_DETAIL_MAX_LENGTH,
  BREAK_GLASS_PARAMETERS_MAX_BYTES,
  BREAK_GLASS_RESOLUTION_MAX_LENGTH,
  BREAK_GLASS_SESSION_REASONS,
  assertLedgerSafeParameters,
  assertLedgerSafeText,
  composeSessionReason,
  redactErrorMessageForLedger,
} from "./ledger-gate.js";

describe("composeSessionReason", () => {
  it("accepts every registered code without detail (except other)", () => {
    for (const code of Object.values(BREAK_GLASS_SESSION_REASONS)) {
      if (code === BREAK_GLASS_SESSION_REASONS.OTHER) continue;
      expect(composeSessionReason(code, undefined)).toBe(code);
    }
  });

  it("refuses unregistered codes — free-form reasons are not accepted", () => {
    expect(() => composeSessionReason("investigating a thing", undefined)).toThrow(
      expect.objectContaining({ code: BREAK_GLASS_SESSION_REASON_REQUIRED })
    );
  });

  it('requires detail when the code is "other"', () => {
    expect(() => composeSessionReason(BREAK_GLASS_SESSION_REASONS.OTHER, undefined)).toThrow(
      expect.objectContaining({ code: BREAK_GLASS_SESSION_DETAIL_REQUIRED })
    );
    expect(() => composeSessionReason(BREAK_GLASS_SESSION_REASONS.OTHER, "   ")).toThrow(
      expect.objectContaining({ code: BREAK_GLASS_SESSION_DETAIL_REQUIRED })
    );
    expect(
      composeSessionReason(BREAK_GLASS_SESSION_REASONS.OTHER, "one-off data export per LEGAL-88")
    ).toBe("other: one-off data export per LEGAL-88");
  });

  it("composes '<code>: <detail>' with the detail trimmed", () => {
    expect(
      composeSessionReason(
        BREAK_GLASS_SESSION_REASONS.STUCK_WORKFLOW_RECOVERY,
        "  order ORD-7 stuck per INC-2214  "
      )
    ).toBe("stuck-workflow.recovery: order ORD-7 stuck per INC-2214");
  });

  it("refuses PHI-shaped detail and never quotes it back", () => {
    const secret = "patient: Jane Doe, DOB: 1962-07-04";
    try {
      composeSessionReason(BREAK_GLASS_SESSION_REASONS.DATA_REPAIR, secret);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toMatchObject({ code: BREAK_GLASS_LEDGER_TEXT_REJECTED });
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("patient_label");
      expect(message).not.toContain("Jane Doe");
    }
  });

  it("bounds the detail", () => {
    expect(() =>
      composeSessionReason(
        BREAK_GLASS_SESSION_REASONS.DATA_REPAIR,
        "x".repeat(BREAK_GLASS_DETAIL_MAX_LENGTH + 1)
      )
    ).toThrow(expect.objectContaining({ code: BREAK_GLASS_LEDGER_TEXT_TOO_LONG }));
  });
});

describe("assertLedgerSafeText", () => {
  it("passes clean bounded text", () => {
    expect(() =>
      assertLedgerSafeText(
        "replayed outbox row, order resumed; see INC-2214",
        "resolution",
        BREAK_GLASS_RESOLUTION_MAX_LENGTH
      )
    ).not.toThrow();
  });

  it("refuses over-length text", () => {
    expect(() =>
      assertLedgerSafeText(
        "x".repeat(BREAK_GLASS_RESOLUTION_MAX_LENGTH + 1),
        "resolution",
        BREAK_GLASS_RESOLUTION_MAX_LENGTH
      )
    ).toThrow(expect.objectContaining({ code: BREAK_GLASS_LEDGER_TEXT_TOO_LONG }));
  });
});

describe("assertLedgerSafeParameters", () => {
  it("passes identifiers and switches", () => {
    expect(() =>
      assertLedgerSafeParameters({
        orderId: "0193b6f2-1d2e-7f3a-9c4b-5a6d7e8f9a0b",
        dryRun: true,
        limit: 50,
        tags: ["INC-2214"],
      })
    ).not.toThrow();
    expect(() => assertLedgerSafeParameters(null)).not.toThrow();
    expect(() => assertLedgerSafeParameters(undefined)).not.toThrow();
  });

  it("screens strings at any depth — values and keys", () => {
    expect(() =>
      assertLedgerSafeParameters({ where: { list: [{ email: "nurse@example-clinic.com" }] } })
    ).toThrow(expect.objectContaining({ code: BREAK_GLASS_LEDGER_TEXT_REJECTED }));
    expect(() => assertLedgerSafeParameters({ "patient: 4a91c2": true })).toThrow(
      expect.objectContaining({ code: BREAK_GLASS_LEDGER_TEXT_REJECTED })
    );
  });

  it("caps the serialized size", () => {
    expect(() =>
      assertLedgerSafeParameters({ blob: "x".repeat(BREAK_GLASS_PARAMETERS_MAX_BYTES) })
    ).toThrow(expect.objectContaining({ code: BREAK_GLASS_LEDGER_TEXT_TOO_LONG }));
  });

  it("refuses unserializable parameters", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertLedgerSafeParameters(cyclic)).toThrow(
      expect.objectContaining({ code: BREAK_GLASS_LEDGER_TEXT_REJECTED })
    );
  });
});

describe("redactErrorMessageForLedger", () => {
  it("passes clean error text through unchanged", () => {
    expect(redactErrorMessageForLedger("connection reset by peer")).toBe(
      "connection reset by peer"
    );
  });

  it("replaces PHI-shaped text with the rule names, never the text", () => {
    const redacted = redactErrorMessageForLedger(
      "unique violation on patient: Jane Doe DOB: 1962-07-04"
    );
    expect(redacted).toContain("redacted");
    expect(redacted).toContain("patient_label");
    expect(redacted).not.toContain("Jane Doe");
    expect(redacted).not.toContain("1962-07-04");
  });

  it("truncates pathological error text before scanning", () => {
    const long = redactErrorMessageForLedger("x".repeat(10_000));
    expect(long.length).toBeLessThanOrEqual(BREAK_GLASS_RESOLUTION_MAX_LENGTH + 1);
  });
});
