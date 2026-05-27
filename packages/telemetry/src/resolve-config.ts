// Resolve telemetry config from process env.
//
// Twelve-factor: the runtime decides whether OTel is enabled by
// reading three knobs from the environment, not by app-level
// configuration code. The init function in `init-telemetry.ts`
// takes the resolved shape so unit tests can pass synthetic config
// without going through env.
//
// Knobs (all optional; sensible defaults applied):
//
//   OTEL_ENABLED           — "true" / "1" / "yes" to enable; default
//                            "true" in production, "false" elsewhere.
//                            Set "false" explicitly to disable in any
//                            environment.
//
//   OTEL_EXPORTER_OTLP_ENDPOINT
//                          — Collector OTLP/HTTP base URL.
//                            Defaults to "http://localhost:4318".
//                            In production the ECS task definition
//                            points this at the in-cluster collector
//                            sidecar (which fans out to CloudWatch
//                            + Datadog/Honeycomb).
//
//   OTEL_EXPORTER_OTLP_HEADERS
//                          — comma-separated "k=v,k2=v2" list for
//                            collector auth (e.g. Datadog API key,
//                            Honeycomb team token). Forwarded as
//                            HTTP headers on every export batch.
//
//   OTEL_TRACES_SAMPLER_ARG
//                          — float 0..1; defaults to 0.1 in
//                            production (10% trace sampling) and 1.0
//                            elsewhere (100%, since dev traffic is
//                            low-volume).
//
//   OTEL_SERVICE_VERSION   — semver / git sha for the running
//                            artifact. Surfaced as `service.version`
//                            on every resource attribute set.
//
// We deliberately do NOT support the legacy `OTEL_EXPORTER_OTLP_*`
// per-signal endpoint variables (TRACES_ENDPOINT, METRICS_ENDPOINT,
// etc.) — the default base path + signal-suffix pattern from the
// OTLP spec covers our needs and keeps the env surface narrow.

import "server-only";

export interface TelemetryConfig {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly serviceVersion: string | null;
  readonly deploymentEnvironment: string;
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly tracesSamplerRatio: number;
}

export interface ResolveTelemetryConfigInput {
  readonly serviceName: string;
  /** `NODE_ENV` value; influences defaults. */
  readonly nodeEnv: "development" | "test" | "production" | string;
  /** Process env. Defaults to `process.env`. Tests inject. */
  readonly env?: NodeJS.ProcessEnv;
}

export function resolveTelemetryConfigFromEnv(input: ResolveTelemetryConfigInput): TelemetryConfig {
  const env = input.env ?? process.env;
  const isProd = input.nodeEnv === "production";

  const enabledRaw = env.OTEL_ENABLED;
  const enabled = typeof enabledRaw === "string" ? truthy(enabledRaw) : isProd;

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
  const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const serviceVersion = env.OTEL_SERVICE_VERSION ?? null;

  const samplerArg = env.OTEL_TRACES_SAMPLER_ARG;
  let tracesSamplerRatio = isProd ? 0.1 : 1.0;
  if (typeof samplerArg === "string" && samplerArg.length > 0) {
    const parsed = Number.parseFloat(samplerArg);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      tracesSamplerRatio = parsed;
    }
  }

  return Object.freeze({
    enabled,
    serviceName: input.serviceName,
    serviceVersion,
    deploymentEnvironment: input.nodeEnv,
    endpoint,
    headers,
    tracesSamplerRatio,
  });
}

function truthy(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k.length > 0 && v.length > 0) out[k] = v;
  }
  return out;
}
