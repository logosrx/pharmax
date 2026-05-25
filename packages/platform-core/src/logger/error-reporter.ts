// Vendor-neutral error-reporting contract.
//
// platform-core MUST NOT depend on Sentry, Datadog, or any other
// vendor SDK directly — it is consumed by tests, scripts, and every
// app, and pulling in a hosted-service client would leak transitive
// deps everywhere. Instead, this module defines a tiny `ErrorReporter`
// interface that apps implement at boot, and `withErrorReporter`
// wraps any `Logger` so that `.error(...)` ALSO forwards to the
// reporter.
//
// Why a wrapper (vs. expecting every call site to call both):
//
//   1. Call sites already log. The contract `log.error(message, ctx)`
//      is consistent and PHI-safe. Adding "and also remember to call
//      reportError" is exactly the kind of dual-write requirement
//      that gets forgotten in a few months.
//   2. Tests stay decoupled. The default `noopLogger` and the
//      capturing logger in tests never call Sentry, because the
//      reporter is wired in at the application layer.
//   3. PHI redaction works once. The Pino redactor inside
//      `createPinoLogger` runs BEFORE the wrapper hands the context
//      to the reporter (see `pino-logger.ts`). The reporter receives
//      already-scrubbed metadata.
//
// Apps own the reporter implementation:
//
//   import * as Sentry from "@sentry/node";
//   const reporter: ErrorReporter = {
//     captureException(error, ctx) {
//       Sentry.captureException(error, { extra: ctx });
//     },
//     captureMessage(message, ctx) {
//       Sentry.captureMessage(message, { level: "error", extra: ctx });
//     },
//   };
//   export const logger = withErrorReporter(createPinoLogger({ ... }), reporter);

import type { LogContext, Logger } from "./types.js";

/**
 * Surface that an application's error-tracking integration must
 * implement. Two methods because real errors arrive in two flavours:
 *
 *   - `captureException(error, ctx)`: a caught `Error` (with stack)
 *     — the usual case.
 *   - `captureMessage(message, ctx)`: an error-level log with no
 *     `Error` object (e.g. `log.error("audit_chain.invalid", { ... })`
 *     when nothing threw, but the condition is alert-worthy).
 *
 * Implementations should:
 *   - Never block. The logger contract is sync; reporters that need
 *     a network call MUST enqueue / fire-and-forget.
 *   - Never throw. A failed report MUST NOT mask the original log.
 *   - Honour the same PHI invariants as the logger contract. The
 *     `LogContext` arrives ALREADY redacted by the Pino layer; do
 *     not re-add unredacted fields downstream.
 */
export interface ErrorReporter {
  captureException(error: unknown, context?: LogContext): void;
  captureMessage(message: string, context?: LogContext): void;
}

export const noopErrorReporter: ErrorReporter = {
  captureException: () => undefined,
  captureMessage: () => undefined,
};

/**
 * Wrap a base `Logger` so that every `.error(...)` ALSO forwards to
 * `reporter`. `.debug` / `.info` / `.warn` are unchanged — we
 * intentionally do not flood the reporter with non-error events.
 *
 * The reporter receives:
 *   - The first `Error` instance found in `context.error`,
 *     `context.cause`, or `context.err` (in that order). If none is
 *     found, the message is reported via `captureMessage`.
 *   - The entire context object as `extra` metadata (already
 *     PHI-scrubbed by the host `Logger` implementation).
 *
 * `child(bindings)` returns a new wrapped logger whose bindings are
 * inherited at BOTH layers — Pino's child carries the structured
 * fields, and the wrapper continues to forward errors.
 */
export function withErrorReporter(base: Logger, reporter: ErrorReporter): Logger {
  return {
    debug(message, context) {
      base.debug(message, context);
    },
    info(message, context) {
      base.info(message, context);
    },
    warn(message, context) {
      base.warn(message, context);
    },
    error(message, context) {
      base.error(message, context);
      // Best-effort: a reporter failure must NEVER mask the log.
      try {
        const error = extractError(context);
        if (error !== undefined) {
          reporter.captureException(error, withErrorMessage(context, message));
        } else {
          reporter.captureMessage(message, context);
        }
      } catch {
        // Swallow — the original `base.error` already ran and the
        // operator will see the log. Reporter outages are not a
        // reason to crash the request path.
      }
    },
    child(bindings) {
      return withErrorReporter(base.child(bindings), reporter);
    },
  };
}

/**
 * Pull an `Error` out of the context if the caller passed one under
 * any of the common conventional keys. We deliberately do NOT scan
 * arbitrary keys — that would risk treating a non-error duck-typed
 * object as an exception and confusing the reporter UI.
 */
function extractError(context: LogContext | undefined): Error | undefined {
  if (context === undefined) return undefined;
  for (const key of ["error", "cause", "err"] as const) {
    const value = context[key];
    if (value instanceof Error) return value;
  }
  return undefined;
}

/**
 * The log line's `message` is the dev-readable summary. When we
 * report a captured exception, we want the reporter UI to show that
 * summary alongside the stack — usually as an `extra.message` field.
 */
function withErrorMessage(context: LogContext | undefined, message: string): LogContext {
  return { ...(context ?? {}), message };
}
