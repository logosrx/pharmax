// Single access path for OpenTelemetry meters in Pharmax.
//
// Every package that emits custom metrics depends on
// `@pharmax/telemetry` and calls `getMeter("@pharmax/<package>")`.
// Direct dependencies on `@opentelemetry/api` are forbidden outside
// this package — the indirection keeps a single chokepoint for the
// observability stack (e.g. swapping providers, plugging a noop
// shim in tests, applying defensive PHI scrubbing should it ever
// be needed at the API boundary).
//
// No-op safety: when the OTel SDK is NOT initialized
// (`OTEL_ENABLED=false`, the dev default), the global
// `metrics.getMeter(...)` call returns a built-in no-op meter from
// `@opentelemetry/api`. Instrument calls (`counter.add`, etc.)
// silently absorb their arguments. Callers do NOT need to gate
// emissions behind `enabled` checks; the API takes care of it.

import { metrics, type Meter } from "@opentelemetry/api";

/**
 * Return the OpenTelemetry meter for `name`. By convention `name`
 * is the npm package id of the caller (e.g. `@pharmax/command-bus`)
 * so dashboard panels can group instruments by emitter.
 *
 * Returns the global no-op meter when the SDK has not been
 * initialized — safe to call in test/dev with `OTEL_ENABLED=false`.
 */
export function getMeter(name: string): Meter {
  return metrics.getMeter(name);
}
