// Unit tests for the worker's CloudWatch metrics publisher.
//
// The property that matters: production selection REFUSES a boot that
// cannot emit alarm metrics, because "the alarm exists and the metric
// never arrives" is the disconnected-monitoring failure this module
// was written to close. Everything else is plumbing: datums map 1:1
// to PutMetricData entries, empty batches skip the API call, dev logs
// instead of publishing.

import { describe, expect, it, vi } from "vitest";

import {
  buildMetricsPublisher,
  CloudWatchMetricsPublisher,
  LoggingMetricsPublisher,
  type CloudWatchMetricsClient,
} from "./metrics-publisher.js";

interface CapturingLogger {
  readonly lines: Array<{ message: string; fields: unknown }>;
  debug: (message: string, fields?: unknown) => void;
  info: (message: string, fields?: unknown) => void;
  warn: (message: string, fields?: unknown) => void;
  error: (message: string, fields?: unknown) => void;
  fatal: (message: string, fields?: unknown) => void;
  trace: (message: string, fields?: unknown) => void;
  child: () => CapturingLogger;
}

function buildCapturingLogger(): CapturingLogger {
  const lines: Array<{ message: string; fields: unknown }> = [];
  const record = (message: string, fields?: unknown): void => {
    lines.push({ message, fields });
  };
  const logger: CapturingLogger = {
    lines,
    debug: record,
    info: record,
    warn: record,
    error: record,
    fatal: record,
    trace: record,
    child: () => logger,
  };
  return logger;
}

function buildFakeCloudWatch(): {
  readonly client: CloudWatchMetricsClient;
  readonly calls: Array<Parameters<CloudWatchMetricsClient["putMetricData"]>[0]>;
} {
  const calls: Array<Parameters<CloudWatchMetricsClient["putMetricData"]>[0]> = [];
  return {
    calls,
    client: {
      async putMetricData(input) {
        calls.push(input);
      },
    },
  };
}

describe("CloudWatchMetricsPublisher", () => {
  it("maps datums 1:1 with a shared timestamp", async () => {
    const fake = buildFakeCloudWatch();
    const at = new Date("2026-08-07T12:00:00Z");
    const publisher = new CloudWatchMetricsPublisher({ client: fake.client, clock: () => at });

    await publisher.publish("Pharmax/Worker", [
      { metricName: "OutboxUndispatchedDepth", value: 4, unit: "Count" },
      { metricName: "OutboxOldestUndispatchedAgeSeconds", value: 12.5, unit: "Seconds" },
    ]);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({
      Namespace: "Pharmax/Worker",
      MetricData: [
        {
          MetricName: "OutboxUndispatchedDepth",
          Value: 4,
          Unit: "Count",
          Timestamp: at,
        },
        {
          MetricName: "OutboxOldestUndispatchedAgeSeconds",
          Value: 12.5,
          Unit: "Seconds",
          Timestamp: at,
        },
      ],
    });
  });

  it("skips the API call for an empty batch", async () => {
    const fake = buildFakeCloudWatch();
    const publisher = new CloudWatchMetricsPublisher({ client: fake.client });
    await publisher.publish("Pharmax/Worker", []);
    expect(fake.calls).toHaveLength(0);
  });

  it("propagates delivery failures to the caller", async () => {
    const publisher = new CloudWatchMetricsPublisher({
      client: {
        putMetricData: vi.fn(async () => {
          throw new Error("simulated PutMetricData failure");
        }),
      },
    });
    await expect(
      publisher.publish("Pharmax/Worker", [{ metricName: "X", value: 1, unit: "Count" }])
    ).rejects.toThrow("simulated PutMetricData failure");
  });
});

describe("LoggingMetricsPublisher", () => {
  it("logs one structured line per batch", async () => {
    const logger = buildCapturingLogger();
    const publisher = new LoggingMetricsPublisher({
      logger: logger as unknown as ConstructorParameters<
        typeof LoggingMetricsPublisher
      >[0]["logger"],
    });
    await publisher.publish("Pharmax/Audit", [
      { metricName: "AuditChainIntegrityFailure", value: 0, unit: "Count" },
    ]);
    const line = logger.lines.find((l) => l.message === "metrics.publish");
    expect(line).toBeDefined();
    expect(line?.fields).toEqual({
      namespace: "Pharmax/Audit",
      metrics: [{ metricName: "AuditChainIntegrityFailure", value: 0, unit: "Count" }],
    });
  });
});

describe("buildMetricsPublisher", () => {
  const logger = buildCapturingLogger() as unknown as Parameters<
    typeof buildMetricsPublisher
  >[0]["logger"];

  it("selects the logging publisher outside production", async () => {
    const publisher = await buildMetricsPublisher({
      logger,
      env: { NODE_ENV: "test" },
    });
    expect(publisher).toBeInstanceOf(LoggingMetricsPublisher);
  });

  it("selects CloudWatch in production with an injected client", async () => {
    const fake = buildFakeCloudWatch();
    const publisher = await buildMetricsPublisher({
      logger,
      env: { NODE_ENV: "production", AWS_REGION: "us-east-1" },
      cloudWatch: fake.client,
    });
    expect(publisher).toBeInstanceOf(CloudWatchMetricsPublisher);
  });

  it("refuses a production boot without AWS_REGION", async () => {
    await expect(
      buildMetricsPublisher({ logger, env: { NODE_ENV: "production" } })
    ).rejects.toThrow(/AWS_REGION/);
  });
});
