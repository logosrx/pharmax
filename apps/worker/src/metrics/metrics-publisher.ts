// CloudWatch custom-metric publisher for the worker.
//
// CloudWatch alarms can only evaluate CloudWatch metrics. The worker's
// OpenTelemetry meters export over OTLP to whatever collector the
// deployment points them at — a path no CloudWatch alarm can see. So
// every signal that is supposed to PAGE (rather than decorate a
// Grafana dashboard) needs an explicit PutMetricData hop, and this
// module is that hop.
//
// This closes a real hole, not a hypothetical one: the
// `AuditChainIntegrityFailure` alarm in `modules/cloudwatch` shipped
// as a consumer of a metric nothing emitted. It evaluated, stayed
// green (`treat_missing_data = notBreaching`), and could never fire —
// exactly the "monitoring configured but disconnected" posture
// `scripts/check-alarm-actions.ts` exists to prevent on the routing
// side. The emission side had the same disease and no guard.
//
// Publisher selection mirrors `buildEvidencePublisher`:
//   - production → real CloudWatch client (dynamic SDK import), and a
//     missing AWS_REGION refuses the boot — a worker that cannot emit
//     its alarm metrics should fail at deploy time, while someone is
//     watching, not run silently unwatched.
//   - anything else → structured-log publisher; the log line is the
//     assertable artifact in dev and tests.
//
// Failure posture at runtime: `publish` THROWS on delivery failure and
// callers decide. The backlog probe catches and warns — a stale metric
// is tolerable for one tick because the warning-tier alarm treats
// missing data as breaching, so a persistently broken publisher
// surfaces as an alarm rather than as silence.

import type { logger as loggerContract } from "@pharmax/platform-core";

type Logger = loggerContract.Logger;

/** Only the units the worker actually emits; extend when a new metric needs one. */
export type MetricUnit = "Count" | "Seconds";

export interface MetricDatum {
  readonly metricName: string;
  readonly value: number;
  readonly unit: MetricUnit;
}

export interface WorkerMetricsPublisher {
  /**
   * Deliver one batch of datums to a namespace. Implementations may
   * throw; callers own the failure policy (see file header).
   */
  publish(namespace: string, datums: ReadonlyArray<MetricDatum>): Promise<void>;
}

/**
 * Narrow port over `@aws-sdk/client-cloudwatch` so tests never load
 * the SDK. Same pattern as `S3EvidenceObjectStore`.
 */
export interface CloudWatchMetricsClient {
  putMetricData(input: {
    readonly Namespace: string;
    readonly MetricData: ReadonlyArray<{
      readonly MetricName: string;
      readonly Value: number;
      readonly Unit: MetricUnit;
      readonly Timestamp: Date;
    }>;
  }): Promise<void>;
}

export class CloudWatchMetricsPublisher implements WorkerMetricsPublisher {
  private readonly client: CloudWatchMetricsClient;
  private readonly clock: () => Date;

  constructor(options: { readonly client: CloudWatchMetricsClient; readonly clock?: () => Date }) {
    this.client = options.client;
    this.clock = options.clock ?? (() => new Date());
  }

  async publish(namespace: string, datums: ReadonlyArray<MetricDatum>): Promise<void> {
    if (datums.length === 0) return;
    const timestamp = this.clock();
    await this.client.putMetricData({
      Namespace: namespace,
      MetricData: datums.map((d) => ({
        MetricName: d.metricName,
        Value: d.value,
        Unit: d.unit,
        Timestamp: timestamp,
      })),
    });
  }
}

/**
 * Dev/test publisher: one structured log line per batch. The line is
 * the contract tests assert on, and in a pinch an operator can read
 * the same numbers a production alarm would have seen.
 */
export class LoggingMetricsPublisher implements WorkerMetricsPublisher {
  private readonly log: Logger;

  constructor(options: { readonly logger: Logger }) {
    this.log = options.logger.child({ component: "metrics-publisher" });
  }

  async publish(namespace: string, datums: ReadonlyArray<MetricDatum>): Promise<void> {
    this.log.info("metrics.publish", {
      namespace,
      metrics: datums.map((d) => ({ metricName: d.metricName, value: d.value, unit: d.unit })),
    });
    await Promise.resolve();
  }
}

export interface MetricsPublisherEnv {
  readonly NODE_ENV: "development" | "test" | "production";
  readonly AWS_REGION?: string | undefined;
}

/**
 * Resolve the metrics publisher for this process. Production →
 * CloudWatch (AWS_REGION required — see file header for why a
 * missing region refuses the boot). Anything else → logging.
 */
export async function buildMetricsPublisher(options: {
  readonly logger: Logger;
  readonly env: MetricsPublisherEnv;
  /** Inject in tests to avoid resolving the AWS SDK. */
  readonly cloudWatch?: CloudWatchMetricsClient;
}): Promise<WorkerMetricsPublisher> {
  const { logger, env } = options;

  if (env.NODE_ENV !== "production") {
    return new LoggingMetricsPublisher({ logger });
  }

  const region = env.AWS_REGION;
  if (typeof region !== "string" || region.length === 0) {
    throw new Error(
      "Refusing to boot the worker metrics publisher in production without AWS_REGION: " +
        "the outbox backlog and audit-chain alarms consume CloudWatch metrics this process " +
        "emits, and a worker that cannot emit them runs unwatched. Set AWS_REGION."
    );
  }

  const client = options.cloudWatch ?? (await buildCloudWatchMetricsClient(region));
  logger.info("worker.metrics_publisher.cloudwatch", { region });
  return new CloudWatchMetricsPublisher({ client });
}

/**
 * Adapter from the real `@aws-sdk/client-cloudwatch` client to the
 * narrow port. Dynamic import keeps the SDK off the cold-start path
 * for deployments that never publish (dev, test).
 */
export async function buildCloudWatchMetricsClient(
  region: string
): Promise<CloudWatchMetricsClient> {
  const { CloudWatchClient, PutMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
  const client = new CloudWatchClient({ region });
  return {
    async putMetricData(input) {
      await client.send(
        new PutMetricDataCommand({
          Namespace: input.Namespace,
          MetricData: input.MetricData.map((d) => ({
            MetricName: d.MetricName,
            Value: d.Value,
            Unit: d.Unit,
            Timestamp: d.Timestamp,
          })),
        })
      );
    },
  };
}
