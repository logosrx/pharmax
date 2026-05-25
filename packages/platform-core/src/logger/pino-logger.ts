// Pino-backed implementation of the `Logger` contract.
//
// Why Pino:
//   - Structured JSON by default. Every log line is a single object
//     with consistent fields (`level`, `time`, `service`, ...,
//     `message`). Trivial to ingest into Loki, Datadog, CloudWatch.
//   - Native redaction support via `redact: { paths, censor }`. Paths
//     can use wildcards; the censor is the constant string we swap
//     in. This is the foundation of our PHI defense-in-depth.
//   - Children inherit bindings and redact paths, which is exactly
//     what the platform's `child(bindings)` contract needs.
//
// Anti-goals for this module:
//   - Pretty-printing. Pretty output requires `pino-pretty` as a
//     transport. For dev, `pnpm dlx pino-pretty < file` works fine
//     and avoids a runtime dep.
//   - File rotation, log shipping, OTel correlation. Those land in
//     the observability package, not here.
//
// PHI invariant: domain code MUST NOT pass raw patient data into log
// context. The default redact paths (see `redaction.ts`) are a safety
// net for accidents, not a license. See platform-core's
// `logger/types.ts` for the contract.

import {
  pino,
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as PinoLoggerOptions,
} from "pino";

import type { LogContext, Logger } from "./types.js";
import { DEFAULT_REDACT_CENSOR, DEFAULT_REDACT_PATHS } from "./redaction.js";

export type PinoLogLevel = "debug" | "info" | "warn" | "error";

export interface CreatePinoLoggerOptions {
  readonly level?: PinoLogLevel;
  /**
   * Stamps every log line with `service: <value>`. Required because
   * we run multiple processes (web, worker, print-agent) and tail
   * them together.
   */
  readonly service: string;
  /**
   * Extra paths to redact ON TOP OF the default allowlist. Use for
   * domain-specific sensitive fields (e.g. a billing module might add
   * `*.last4`).
   */
  readonly extraRedactPaths?: ReadonlyArray<string>;
  /**
   * Override the censor token. Defaults to `"[Redacted]"`.
   */
  readonly redactCensor?: string;
  /**
   * Optional Pino destination. Defaults to `pino`'s built-in stdout
   * stream. Tests pass an in-memory stream to capture output.
   */
  readonly destination?: DestinationStream;
  /**
   * Pinned base bindings (root-level) — usually unused; service is
   * already wired. Reserved for things like deploy SHA / region.
   */
  readonly base?: Readonly<Record<string, unknown>>;
}

export function createPinoLogger(options: CreatePinoLoggerOptions): Logger {
  const redactPaths = [...DEFAULT_REDACT_PATHS, ...(options.extraRedactPaths ?? [])];

  const pinoOptions: PinoLoggerOptions = {
    level: options.level ?? "info",
    base: {
      service: options.service,
      ...(options.base ?? {}),
    },
    redact: {
      paths: redactPaths,
      censor: options.redactCensor ?? DEFAULT_REDACT_CENSOR,
    },
    // Use ISO-8601 timestamps so logs sort lexically and ingestion
    // pipelines don't have to interpret Unix epoch ms.
    timestamp: pino.stdTimeFunctions.isoTime,
    // We don't use `formatters.level` — Pino's default numeric level
    // is widely supported. `messageKey: "message"` aligns with our
    // `Logger` interface which takes a `message` arg.
    messageKey: "message",
  };

  const instance = options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);

  return wrap(instance);
}

function wrap(instance: PinoLogger): Logger {
  return {
    debug(message, context) {
      instance.debug(toMergeObject(context), message);
    },
    info(message, context) {
      instance.info(toMergeObject(context), message);
    },
    warn(message, context) {
      instance.warn(toMergeObject(context), message);
    },
    error(message, context) {
      instance.error(toMergeObject(context), message);
    },
    child(bindings) {
      return wrap(instance.child(toMergeObject(bindings) ?? {}));
    },
  };
}

/**
 * Pino's level methods accept either `(message)` or `(mergeObject,
 * message)`. Passing `undefined` as the merge object would log
 * `undefined` as an extra field, so we collapse empty/undefined
 * contexts to `undefined` and Pino's overload handles it correctly.
 */
function toMergeObject(context: LogContext | undefined): LogContext | undefined {
  if (context === undefined) return undefined;
  // Spread to lose the readonly modifier (Pino's typing wants a
  // mutable object). The contents are not mutated.
  return { ...context };
}
