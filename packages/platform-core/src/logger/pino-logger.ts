// Pino-backed implementation of the `Logger` contract.
//
// Why Pino:
//   - Structured JSON by default. Every log line is a single object
//     with consistent fields (`level`, `time`, `service`, ...,
//     `message`). Trivial to ingest into Loki, Datadog, CloudWatch.
//   - Children inherit bindings, which is exactly what the platform's
//     `child(bindings)` contract needs.
//
// Redaction does NOT use Pino's `redact` option. Path-based redaction
// only reaches the depths it enumerates, and the wildcard paths needed
// to go deeper dominate the cost of a log line. We scrub the context
// ourselves on the way in — see `redaction.ts` for the reasoning and
// the measurements.
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
import { createLogContextRedactor, type LogContextRedactor } from "./redaction.js";

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
   * Extra field names to redact ON TOP OF the defaults. Use for
   * domain-specific sensitive fields (e.g. a billing module might add
   * `last4`). Plain names, matched case-insensitively at any depth.
   */
  readonly extraSensitiveFields?: ReadonlyArray<string>;
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
  const redact = createLogContextRedactor({
    ...(options.extraSensitiveFields !== undefined
      ? { extraSensitiveFields: options.extraSensitiveFields }
      : {}),
    ...(options.redactCensor !== undefined ? { censor: options.redactCensor } : {}),
  });

  const pinoOptions: PinoLoggerOptions = {
    level: options.level ?? "info",
    base: {
      service: options.service,
      // Scrubbed once at construction: `base` is caller-supplied and
      // is stamped on every line, so an unscrubbed value here would
      // leak on every log rather than once.
      ...(options.base !== undefined ? redact(options.base) : {}),
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

  return wrap(instance, redact);
}

function wrap(instance: PinoLogger, redact: LogContextRedactor): Logger {
  return {
    debug(message, context) {
      instance.debug(toMergeObject(context, redact), message);
    },
    info(message, context) {
      instance.info(toMergeObject(context, redact), message);
    },
    warn(message, context) {
      instance.warn(toMergeObject(context, redact), message);
    },
    error(message, context) {
      instance.error(toMergeObject(context, redact), message);
    },
    child(bindings) {
      // Bindings are scrubbed here so the cost is paid once per child
      // rather than on every line the child emits.
      return wrap(instance.child(toMergeObject(bindings, redact) ?? {}), redact);
    },
  };
}

/**
 * Pino's level methods accept either `(message)` or `(mergeObject,
 * message)`. Passing `undefined` as the merge object would log
 * `undefined` as an extra field, so we collapse empty/undefined
 * contexts to `undefined` and Pino's overload handles it correctly.
 *
 * The redactor returns a fresh object, which also drops the readonly
 * modifier that Pino's typing rejects.
 */
function toMergeObject(
  context: LogContext | undefined,
  redact: LogContextRedactor
): LogContext | undefined {
  if (context === undefined) return undefined;
  return redact(context);
}
