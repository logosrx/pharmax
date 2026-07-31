// Single access path for OpenTelemetry TRACES in Pharmax.
//
// Mirrors `get-meter.ts`: every package that emits custom spans
// depends on `@pharmax/telemetry` and goes through these helpers.
// Direct dependencies on `@opentelemetry/api` are forbidden outside
// this package — one chokepoint for the observability stack.
//
// Why this exists (Phase 6 hardening): the NodeSDK auto-
// instrumentations give us HTTP/fetch/pg spans WITHIN one process,
// but Pharmax's cross-service hops are DB-backed queues, not HTTP:
//
//   web command  → event_outbox row   → worker outbox drainer
//   worker fan-out → webhook_delivery → worker delivery drainer
//   web command  → print_job row      → print-agent claim loop
//
// No HTTP request crosses those boundaries, so auto-instrumentation
// cannot propagate trace context across them. Instead the producer
// persists the active W3C `traceparent` on the queue row
// (`currentTraceparent()`), and the consumer resumes the trace by
// passing the persisted value to `withSpan({ parentTraceparent })`.
//
// PHI rule: span names and attributes follow the same discipline as
// logs — ids, event types, statuses, and counts only. NEVER patient
// names, addresses, prescription contents, or rendered label data.
//
// No-op safety: when the OTel SDK is not initialized
// (`OTEL_ENABLED=false`, the dev default), `trace.getTracer` returns
// a no-op tracer, `withSpan` still runs `fn` (with a non-recording
// span), and `currentTraceparent()` returns null because the global
// propagator is a no-op. Callers never need to gate on `enabled`.

import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";

/**
 * Return the OpenTelemetry tracer for `name`. By convention `name`
 * is the npm package id of the caller (e.g. `@pharmax/command-bus`),
 * matching the `getMeter` convention.
 */
export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

/**
 * Serialize the ACTIVE trace context as a W3C `traceparent` string,
 * or null when there is no active recorded context (SDK disabled,
 * or the caller is not inside a span). Producers persist this on
 * queue rows (`event_outbox.traceparent`, `webhook_delivery
 * .traceparent`, `print_job.traceparent`) so consumers in another
 * process can resume the trace.
 */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const traceparent = carrier["traceparent"];
  return typeof traceparent === "string" && traceparent.length > 0 ? traceparent : null;
}

/**
 * Span kind as a plain string union so callers don't need
 * `@opentelemetry/api` imports. `consumer` is the right kind for
 * queue-row processing; `producer` for the enqueue side when it
 * wants an explicit span; `client` for outbound I/O that auto-
 * instrumentation cannot see (e.g. the print-agent's raw TCP send).
 */
export type PharmaxSpanKind = "internal" | "producer" | "consumer" | "client" | "server";

const SPAN_KIND_MAP: Readonly<Record<PharmaxSpanKind, SpanKind>> = Object.freeze({
  internal: SpanKind.INTERNAL,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
  client: SpanKind.CLIENT,
  server: SpanKind.SERVER,
});

export interface WithSpanOptions {
  /** Tracer name; by convention the caller's npm package id. */
  readonly tracerName: string;
  readonly spanName: string;
  readonly kind?: PharmaxSpanKind;
  /** Ids / enums / counts only — never PHI. */
  readonly attributes?: Attributes;
  /**
   * W3C `traceparent` persisted by the producer of a queue row.
   * When set (non-null, non-empty), the new span joins that trace
   * as a remote child. When null/undefined/unparseable, the span
   * starts under the caller's active context (or as a new root).
   */
  readonly parentTraceparent?: string | null;
}

/**
 * Run `fn` inside an active span. Errors are recorded on the span
 * (exception event + ERROR status) and rethrown — control flow is
 * unchanged. The span always ends, and `fn`'s result is returned.
 */
export async function withSpan<T>(
  options: WithSpanOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer(options.tracerName);
  const kind = SPAN_KIND_MAP[options.kind ?? "internal"];

  let parentContext: Context = context.active();
  const traceparent = options.parentTraceparent;
  if (typeof traceparent === "string" && traceparent.length > 0) {
    parentContext = propagation.extract(context.active(), { traceparent });
  }

  return tracer.startActiveSpan(
    options.spanName,
    { kind, ...(options.attributes === undefined ? {} : { attributes: options.attributes }) },
    parentContext,
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (cause) {
        span.recordException(cause instanceof Error ? cause : String(cause));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: cause instanceof Error ? cause.message : "Unknown error",
        });
        throw cause;
      } finally {
        span.end();
      }
    }
  );
}
