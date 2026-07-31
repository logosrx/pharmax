// Tests for the tracing chokepoint helpers.
//
// These run WITHOUT an initialized OTel SDK — the same posture as
// every unit-test process in the repo (`OTEL_ENABLED=false`). The
// load-bearing assertions are therefore the no-op-safety
// guarantees: helpers never throw, never change control flow, and
// `currentTraceparent()` reports null instead of fabricating
// context. Recording-path behavior (sampling, export) is exercised
// against a real collector in staging, not unit tests.

import { describe, expect, it } from "vitest";

import { currentTraceparent, getTracer, withSpan } from "./tracing.js";

describe("getTracer", () => {
  it("returns a tracer without an initialized SDK", () => {
    const tracer = getTracer("@pharmax/telemetry.test");
    expect(tracer).toBeDefined();
    expect(typeof tracer.startActiveSpan).toBe("function");
  });
});

describe("currentTraceparent", () => {
  it("returns null when no SDK/propagator is registered", () => {
    // The global propagator is a no-op before initTelemetry runs, so
    // inject() writes nothing into the carrier.
    expect(currentTraceparent()).toBeNull();
  });
});

describe("withSpan", () => {
  it("runs fn and returns its result", async () => {
    const result = await withSpan(
      { tracerName: "@pharmax/telemetry.test", spanName: "unit.noop" },
      async () => 42
    );
    expect(result).toBe(42);
  });

  it("passes a span handle to fn", async () => {
    await withSpan(
      { tracerName: "@pharmax/telemetry.test", spanName: "unit.span" },
      async (span) => {
        expect(typeof span.end).toBe("function");
        expect(typeof span.setAttribute).toBe("function");
        return undefined;
      }
    );
  });

  it("rethrows fn errors unchanged", async () => {
    const boom = new Error("handler exploded");
    await expect(
      withSpan({ tracerName: "@pharmax/telemetry.test", spanName: "unit.throw" }, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });

  it("rethrows non-Error throws unchanged", async () => {
    await expect(
      withSpan(
        { tracerName: "@pharmax/telemetry.test", spanName: "unit.throw_string" },
        async () => {
          throw "string failure";
        }
      )
    ).rejects.toBe("string failure");
  });

  it.each(["internal", "producer", "consumer", "client", "server"] as const)(
    "accepts span kind %s",
    async (kind) => {
      const result = await withSpan(
        { tracerName: "@pharmax/telemetry.test", spanName: `unit.kind.${kind}`, kind },
        async () => kind
      );
      expect(result).toBe(kind);
    }
  );

  it("accepts a persisted parent traceparent", async () => {
    // Well-formed W3C traceparent (sampled flag set). With the no-op
    // propagator this is ignored; the guarantee under test is that a
    // persisted value never breaks the consumer's control flow.
    const result = await withSpan(
      {
        tracerName: "@pharmax/telemetry.test",
        spanName: "unit.remote_parent",
        kind: "consumer",
        parentTraceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        attributes: { "pharmax.outbox_id": "00000000-0000-0000-0000-000000000000" },
      },
      async () => "resumed"
    );
    expect(result).toBe("resumed");
  });

  it("tolerates null / empty / malformed parent traceparent", async () => {
    for (const parentTraceparent of [null, "", "not-a-traceparent"]) {
      const result = await withSpan(
        {
          tracerName: "@pharmax/telemetry.test",
          spanName: "unit.bad_parent",
          parentTraceparent,
        },
        async () => "ok"
      );
      expect(result).toBe("ok");
    }
  });
});
