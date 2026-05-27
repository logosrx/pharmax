import { describe, expect, it } from "vitest";

import { resolveTelemetryConfigFromEnv } from "./resolve-config.js";

describe("resolveTelemetryConfigFromEnv — defaults", () => {
  it("disables OTel in development by default", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "development",
      env: {},
    });
    expect(cfg.enabled).toBe(false);
  });

  it("enables OTel in production by default", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "production",
      env: {},
    });
    expect(cfg.enabled).toBe(true);
  });

  it("OTEL_ENABLED=false overrides the production default", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "production",
      env: { OTEL_ENABLED: "false" },
    });
    expect(cfg.enabled).toBe(false);
  });

  it("OTEL_ENABLED=true overrides the dev default", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "development",
      env: { OTEL_ENABLED: "1" },
    });
    expect(cfg.enabled).toBe(true);
  });

  it("uses localhost:4318 when OTLP endpoint is unset", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "production",
      env: {},
    });
    expect(cfg.endpoint).toBe("http://localhost:4318");
  });

  it("respects an explicit OTLP endpoint", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "production",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.local.dev/foo" },
    });
    expect(cfg.endpoint).toBe("https://otel.local.dev/foo");
  });
});

describe("resolveTelemetryConfigFromEnv — headers", () => {
  it("parses comma-separated k=v pairs", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "production",
      env: {
        OTEL_EXPORTER_OTLP_HEADERS: "x-dd-api-key=abc, x-honeycomb-team=def , malformed",
      },
    });
    expect(cfg.headers).toEqual({
      "x-dd-api-key": "abc",
      "x-honeycomb-team": "def",
    });
  });

  it("returns an empty object when headers are unset", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "production",
      env: {},
    });
    expect(cfg.headers).toEqual({});
  });
});

describe("resolveTelemetryConfigFromEnv — sampler", () => {
  it("defaults to 0.1 in production", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "production",
      env: {},
    });
    expect(cfg.tracesSamplerRatio).toBe(0.1);
  });

  it("defaults to 1.0 outside production", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "development",
      env: {},
    });
    expect(cfg.tracesSamplerRatio).toBe(1.0);
  });

  it("clamps invalid sampler args back to the default", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "production",
      env: { OTEL_TRACES_SAMPLER_ARG: "not-a-number" },
    });
    expect(cfg.tracesSamplerRatio).toBe(0.1);
  });

  it("ignores out-of-range sampler args", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "production",
      env: { OTEL_TRACES_SAMPLER_ARG: "2.5" },
    });
    expect(cfg.tracesSamplerRatio).toBe(0.1);
  });

  it("respects a valid in-range sampler arg", () => {
    const cfg = resolveTelemetryConfigFromEnv({
      serviceName: "pharmacy-web",
      nodeEnv: "production",
      env: { OTEL_TRACES_SAMPLER_ARG: "0.25" },
    });
    expect(cfg.tracesSamplerRatio).toBe(0.25);
  });
});
