import { describe, expect, it } from "vitest";

import { createLogContextRedactor } from "./redaction.js";
import type { Logger } from "./types.js";
import { noopErrorReporter, withErrorReporter, type ErrorReporter } from "./error-reporter.js";

function createCapturingLogger(): {
  logger: Logger;
  calls: Array<{ level: "debug" | "info" | "warn" | "error"; message: string; context?: unknown }>;
} {
  const calls: Array<{
    level: "debug" | "info" | "warn" | "error";
    message: string;
    context?: unknown;
  }> = [];
  const make = (): Logger => ({
    debug: (message, context) => calls.push({ level: "debug", message, context }),
    info: (message, context) => calls.push({ level: "info", message, context }),
    warn: (message, context) => calls.push({ level: "warn", message, context }),
    error: (message, context) => calls.push({ level: "error", message, context }),
    child: () => make(),
  });
  return { logger: make(), calls };
}

function createMockReporter(): ErrorReporter & {
  exceptionCalls: Array<{ error: unknown; context?: unknown }>;
  messageCalls: Array<{ message: string; context?: unknown }>;
} {
  const exceptionCalls: Array<{ error: unknown; context?: unknown }> = [];
  const messageCalls: Array<{ message: string; context?: unknown }> = [];
  return {
    captureException: (error, context) => {
      exceptionCalls.push({ error, context });
    },
    captureMessage: (message, context) => {
      messageCalls.push({ message, context });
    },
    exceptionCalls,
    messageCalls,
  };
}

describe("withErrorReporter", () => {
  it("forwards debug/info/warn calls to base logger only", () => {
    const { logger, calls } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);

    wrapped.debug("d", { a: 1 });
    wrapped.info("i", { b: 2 });
    wrapped.warn("w", { c: 3 });

    expect(calls).toEqual([
      { level: "debug", message: "d", context: { a: 1 } },
      { level: "info", message: "i", context: { b: 2 } },
      { level: "warn", message: "w", context: { c: 3 } },
    ]);
    expect(reporter.exceptionCalls).toHaveLength(0);
    expect(reporter.messageCalls).toHaveLength(0);
  });

  it("forwards error() to base AND reports as message when no Error in context", () => {
    const { logger, calls } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);

    wrapped.error("alert", { code: "FOO" });

    expect(calls).toEqual([{ level: "error", message: "alert", context: { code: "FOO" } }]);
    expect(reporter.exceptionCalls).toHaveLength(0);
    expect(reporter.messageCalls).toEqual([{ message: "alert", context: { code: "FOO" } }]);
  });

  it("captures Error from context.error", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);
    const error = new Error("boom");

    wrapped.error("operation_failed", { error, code: "OP_X" });

    expect(reporter.exceptionCalls).toEqual([
      {
        error,
        context: { error, code: "OP_X", message: "operation_failed" },
      },
    ]);
    expect(reporter.messageCalls).toHaveLength(0);
  });

  it("captures Error from context.cause when context.error is not an Error", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);
    const cause = new Error("root cause");

    wrapped.error("downstream", { error: "not an error object", cause });

    expect(reporter.exceptionCalls).toHaveLength(1);
    expect(reporter.exceptionCalls[0]!.error).toBe(cause);
  });

  it("captures Error from context.err as fallback", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);
    const err = new Error("legacy");

    wrapped.error("legacy_path", { err });

    expect(reporter.exceptionCalls).toHaveLength(1);
    expect(reporter.exceptionCalls[0]!.error).toBe(err);
  });

  it("never throws when reporter throws", () => {
    const { logger, calls } = createCapturingLogger();
    const reporter: ErrorReporter = {
      captureException: () => {
        throw new Error("sentry offline");
      },
      captureMessage: () => {
        throw new Error("sentry offline");
      },
    };
    const wrapped = withErrorReporter(logger, reporter);

    expect(() => wrapped.error("alert", { error: new Error("x") })).not.toThrow();
    // Critical invariant: base log still ran.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.level).toBe("error");
  });

  it("child() returns a wrapped logger that still forwards errors", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);
    const child = wrapped.child({ requestId: "r1" });
    const error = new Error("nested");

    child.error("nested_failure", { error });

    expect(reporter.exceptionCalls).toHaveLength(1);
    expect(reporter.exceptionCalls[0]!.error).toBe(error);
  });

  it("noopErrorReporter is a safe default", () => {
    expect(() => noopErrorReporter.captureException(new Error("x"))).not.toThrow();
    expect(() => noopErrorReporter.captureMessage("x")).not.toThrow();
  });
});

// The wrapper sits outside the base logger, so it sees the caller's
// raw context. `base.error` scrubs on its own way to Pino, but that
// copy is internal — if the wrapper does not scrub too, the reporter
// receives unredacted metadata. The interface doc promises callers it
// does not, and a reporter without its own scrubber would leak.
describe("withErrorReporter — PHI scrubbing before the reporter", () => {
  it("scrubs sensitive fields out of captureMessage context", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);

    wrapped.error("audit_chain.invalid", { mrn: "MRN-123", orderId: "ord_1" });

    expect(reporter.messageCalls[0]!.context).toEqual({
      mrn: "[Redacted]",
      orderId: "ord_1",
    });
  });

  it("scrubs sensitive fields out of captureException context", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);
    const error = new Error("upstream timeout");

    wrapped.error("dispatch.failed", { error, dateOfBirth: "1970-01-01", orderId: "ord_2" });

    expect(reporter.exceptionCalls[0]!.context).toEqual({
      error,
      dateOfBirth: "[Redacted]",
      orderId: "ord_2",
      message: "dispatch.failed",
    });
  });

  it("scrubs at depth, not just the top level", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);

    wrapped.error("nested", { a: { b: { c: { ssn: "000-00-0000", keep: "yes" } } } });

    expect(reporter.messageCalls[0]!.context).toEqual({
      a: { b: { c: { ssn: "[Redacted]", keep: "yes" } } },
    });
  });

  it("forwards the original Error instance, not a scrubbed copy", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);
    const error = new Error("boom");

    wrapped.error("failed", { error, mrn: "MRN-9" });

    // Identity matters: rebuilding the Error would discard the stack,
    // which is the only reason to hand it to the reporter at all.
    expect(reporter.exceptionCalls[0]!.error).toBe(error);
    expect((reporter.exceptionCalls[0]!.error as Error).stack).toBe(error.stack);
  });

  it("does not mutate the caller's context object", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter);
    const context = { mrn: "MRN-123", nested: { phone: "555-0100" } };

    wrapped.error("failed", context);

    expect(context.mrn).toBe("MRN-123");
    expect(context.nested.phone).toBe("555-0100");
  });

  it("honours a caller-supplied redactor for app-specific fields", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter, {
      redact: createLogContextRedactor({ extraSensitiveFields: ["last4"] }),
    });

    wrapped.error("charge.failed", { last4: "4242", chargeId: "ch_1" });

    expect(reporter.messageCalls[0]!.context).toEqual({
      last4: "[Redacted]",
      chargeId: "ch_1",
    });
  });

  it("keeps scrubbing through child()", () => {
    const { logger } = createCapturingLogger();
    const reporter = createMockReporter();
    const wrapped = withErrorReporter(logger, reporter, {
      redact: createLogContextRedactor({ extraSensitiveFields: ["last4"] }),
    });

    wrapped.child({ requestId: "r1" }).error("charge.failed", { last4: "4242" });

    // Also proves the options survive the child hop — a child that
    // dropped them would silently stop redacting `last4`.
    expect(reporter.messageCalls[0]!.context).toEqual({ last4: "[Redacted]" });
  });
});
