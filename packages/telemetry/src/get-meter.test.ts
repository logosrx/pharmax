// `getMeter` no-op safety check.
//
// The OTel SDK is never initialized in this test process, so
// `metrics.getMeter(...)` must return the global no-op meter from
// `@opentelemetry/api`. Instrument operations (counter add,
// histogram record, observable gauge with callback) MUST silently
// absorb their arguments without throwing — that's the contract
// the rest of the codebase relies on for the `OTEL_ENABLED=false`
// path.

import { describe, expect, it } from "vitest";

import { getMeter } from "./get-meter.js";

describe("getMeter — no-op safety when SDK is not initialized", () => {
  it("returns a meter whose Counter.add does not throw", () => {
    const meter = getMeter("@pharmax/test");
    const counter = meter.createCounter("pharmax_test_counter", {
      description: "test counter (no-op safety check)",
    });
    expect(() => counter.add(1, { outcome: "success" })).not.toThrow();
    expect(() => counter.add(3)).not.toThrow();
  });

  it("returns a meter whose Histogram.record does not throw", () => {
    const meter = getMeter("@pharmax/test");
    const histogram = meter.createHistogram("pharmax_test_histogram_seconds", {
      unit: "s",
      description: "test histogram (no-op safety check)",
    });
    expect(() => histogram.record(0.1, { command_name: "Sample" })).not.toThrow();
    expect(() => histogram.record(1.5)).not.toThrow();
  });

  it("registers an ObservableGauge callback without throwing and accepts observe calls", () => {
    const meter = getMeter("@pharmax/test");
    const gauge = meter.createObservableGauge("pharmax_test_gauge", {
      description: "test observable gauge (no-op safety check)",
    });
    expect(() =>
      gauge.addCallback((result) => {
        result.observe(42, { organization_id: "00000000-0000-0000-0000-000000000000" });
      })
    ).not.toThrow();
  });

  it("returns the same Meter instance shape for repeated calls", () => {
    const m1 = getMeter("@pharmax/test");
    const m2 = getMeter("@pharmax/test");
    expect(typeof m1.createCounter).toBe("function");
    expect(typeof m2.createHistogram).toBe("function");
  });
});
