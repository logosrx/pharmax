// OpenTelemetry initialization for all Pharmax Node services.
//
// Call once, FIRST THING in the process — before importing anything
// that uses Node's `http`, `pg`, `aws-sdk`, etc. — so the
// auto-instrumentations can patch those modules. The `register()`
// hook in `apps/web/instrumentation.ts` runs before any request is
// handled. The worker + print-agent call this at the top of `main()`.
//
// What we wire:
//
//   - NodeSDK from @opentelemetry/sdk-node, configured with:
//       * traces  → OTLP/HTTP exporter (BatchSpanProcessor)
//       * metrics → OTLP/HTTP exporter (PeriodicExportingMetricReader)
//       * resource → service.name, service.version,
//                    deployment.environment, host.name
//   - `auto-instrumentations-node` for HTTP, fetch, undici, Express,
//     Next, pg, mysql, AWS SDK v3, Redis, ioredis. We DO NOT enable
//     the `fs` instrumentation by default — it produces an enormous
//     volume of low-signal spans.
//
// Handle returned by `initTelemetry` exposes `shutdown()` for
// graceful exit (flushes pending spans + metric exports). The
// worker + print-agent already register SIGINT/SIGTERM handlers;
// they call `handle.shutdown()` alongside Sentry.flush() and
// Prisma.$disconnect().
//
// Disabled mode: when `config.enabled === false`, we still return a
// handle, but it's a no-op (`shutdown()` resolves immediately). This
// keeps call sites uniform across dev / prod.
//
// Important: this module dynamically imports the OTel SDK packages
// so test environments that don't install the OTel packages can
// still import @pharmax/telemetry without throwing. The dynamic
// import only runs when `enabled === true`.

import "server-only";

import type { TelemetryConfig } from "./resolve-config.js";

// Type-only imports for the OTel SDK packages. `import type` is
// erased at compile time, so this does NOT introduce a runtime
// dependency — test environments that don't install these
// packages still load @pharmax/telemetry fine. The runtime
// `import(...)` calls inside `initTelemetry` are the real
// load path; these type aliases just satisfy
// `@typescript-eslint/consistent-type-imports` (which forbids
// inline `typeof import(...)` annotations).
import type * as SdkMod from "@opentelemetry/sdk-node";
import type * as TraceExporterMod from "@opentelemetry/exporter-trace-otlp-http";
import type * as MetricsExporterMod from "@opentelemetry/exporter-metrics-otlp-http";
import type * as SdkMetricsMod from "@opentelemetry/sdk-metrics";
import type * as ResourcesMod from "@opentelemetry/resources";
import type * as SemconvMod from "@opentelemetry/semantic-conventions";
import type * as AutoinstMod from "@opentelemetry/auto-instrumentations-node";

export interface TelemetryInitOptions {
  readonly config: TelemetryConfig;
  /**
   * Optional log sink for boot diagnostics. Defaults to no-op so
   * @pharmax/telemetry has zero hard dependency on a logger
   * package — apps pass their own pino instance.
   */
  readonly onBootDiagnostic?: (
    level: "info" | "warn",
    event: string,
    details: Record<string, unknown>
  ) => void;
}

export interface TelemetryHandle {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly shutdown: () => Promise<void>;
}

const NOOP_HANDLE = (config: TelemetryConfig): TelemetryHandle =>
  Object.freeze({
    enabled: false,
    serviceName: config.serviceName,
    shutdown: async () => undefined,
  });

export async function initTelemetry(options: TelemetryInitOptions): Promise<TelemetryHandle> {
  const log =
    options.onBootDiagnostic ??
    ((_level, _event, _details) => {
      /* swallow */
    });

  const cfg = options.config;
  if (!cfg.enabled) {
    log("info", "telemetry.disabled", {
      serviceName: cfg.serviceName,
      reason: "OTEL_ENABLED is not truthy in this environment",
    });
    return NOOP_HANDLE(cfg);
  }

  // Dynamic imports so dev tooling that doesn't install the OTel
  // packages (e.g. unit-test runner) doesn't trip on the require.
  // Variable types reference the top-of-file `import type * as`
  // aliases; those are erased at compile time so no runtime
  // dependency leaks here.
  let sdkMod: typeof SdkMod;
  let traceExporterMod: typeof TraceExporterMod;
  let metricsExporterMod: typeof MetricsExporterMod;
  let sdkMetricsMod: typeof SdkMetricsMod;
  let resourcesMod: typeof ResourcesMod;
  let semconvMod: typeof SemconvMod;
  let autoinstMod: typeof AutoinstMod;
  try {
    [
      sdkMod,
      traceExporterMod,
      metricsExporterMod,
      sdkMetricsMod,
      resourcesMod,
      semconvMod,
      autoinstMod,
    ] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
      import("@opentelemetry/auto-instrumentations-node"),
    ]);
  } catch (cause) {
    log("warn", "telemetry.sdk_unavailable", {
      serviceName: cfg.serviceName,
      reason: "OpenTelemetry SDK packages not installed",
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NOOP_HANDLE(cfg);
  }

  const { NodeSDK } = sdkMod;
  const { OTLPTraceExporter } = traceExporterMod;
  const { OTLPMetricExporter } = metricsExporterMod;
  const { PeriodicExportingMetricReader } = sdkMetricsMod;
  const { Resource } = resourcesMod;
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } = semconvMod;
  // `host.name` is a stable OTel attribute key, but the typed
  // constant is not re-exported in every semantic-conventions
  // minor. The string literal is part of the OTel spec.
  const ATTR_HOST_NAME = "host.name";
  const { getNodeAutoInstrumentations } = autoinstMod;

  const headers = cfg.headers;
  const tracesUrl = joinUrl(cfg.endpoint, "/v1/traces");
  const metricsUrl = joinUrl(cfg.endpoint, "/v1/metrics");

  const traceExporter = new OTLPTraceExporter({ url: tracesUrl, headers });
  const metricExporter = new OTLPMetricExporter({ url: metricsUrl, headers });

  const resourceAttrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: cfg.deploymentEnvironment,
    [ATTR_HOST_NAME]: process.env.HOSTNAME ?? "unknown-host",
  };
  if (cfg.serviceVersion !== null) {
    resourceAttrs[ATTR_SERVICE_VERSION] = cfg.serviceVersion;
  }

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });

  const sdk = new NodeSDK({
    resource: new Resource(resourceAttrs),
    traceExporter,
    // Cast: NodeSDK and PeriodicExportingMetricReader can be
    // resolved from two different copies of @opentelemetry/sdk-metrics
    // depending on which transitive bumped first. The runtime
    // contract (MetricReader interface) is identical; the type
    // identity is what mismatches. Suppressing here is safer than
    // forcing a dep resolution override that may break other
    // OTel users in the workspace.
    metricReader: metricReader as never,
    instrumentations: [
      getNodeAutoInstrumentations({
        // The `fs` instrumentation generates an enormous volume of
        // spans (every `fs.readFile` becomes one). Keep it off unless
        // we are specifically debugging filesystem I/O.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        // Net is similarly noisy and rarely useful.
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
    ],
  });

  try {
    sdk.start();
    log("info", "telemetry.started", {
      serviceName: cfg.serviceName,
      endpoint: cfg.endpoint,
      deploymentEnvironment: cfg.deploymentEnvironment,
      tracesSamplerRatio: cfg.tracesSamplerRatio,
      serviceVersion: cfg.serviceVersion,
      hasHeaders: Object.keys(headers).length > 0,
    });
  } catch (cause) {
    log("warn", "telemetry.start_failed", {
      serviceName: cfg.serviceName,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return NOOP_HANDLE(cfg);
  }

  return Object.freeze({
    enabled: true,
    serviceName: cfg.serviceName,
    shutdown: async () => {
      try {
        await sdk.shutdown();
        log("info", "telemetry.shutdown", { serviceName: cfg.serviceName });
      } catch (cause) {
        log("warn", "telemetry.shutdown_failed", {
          serviceName: cfg.serviceName,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
  });
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}
