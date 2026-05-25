import { describe, expect, it } from "vitest";

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
