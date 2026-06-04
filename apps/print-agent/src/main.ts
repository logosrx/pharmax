import { prisma } from "@pharmax/database";
import {
  initTelemetry,
  resolveTelemetryConfigFromEnv,
  type TelemetryHandle,
} from "@pharmax/telemetry";

import { bootstrap } from "./bootstrap.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { flushSentry } from "./observability/sentry-init.js";
import { createZplTransport } from "./printer/send-zpl.js";
import { processNextSentPrintJob, refreshTenancyCorrelation } from "./process-sent-print-job.js";
import { createLivenessHeartbeat } from "./runtime/liveness.js";
import { createPollLoop } from "./runtime/poll-loop.js";
import {
  resolvePrintAgentRuntimeContext,
  type PrintAgentRuntimeContext,
} from "./resolve-runtime-context.js";

let telemetryHandle: TelemetryHandle | null = null;

async function main(): Promise<void> {
  // 0. OpenTelemetry first — patches the network primitives the
  // ZPL transport uses (tcp net + http for ZPL-over-HTTP modes).
  // Failure is non-fatal; the agent prints labels with or without
  // tracing.
  const telemetryConfig = resolveTelemetryConfigFromEnv({
    serviceName: "pharmacy-print-agent",
    nodeEnv: env.NODE_ENV,
  });
  telemetryHandle = await initTelemetry({
    config: telemetryConfig,
    onBootDiagnostic: (level, event, details) => {
      logger[level](event, details);
    },
  });

  bootstrap();

  const runtime = await resolvePrintAgentRuntimeContext(prisma, {
    organizationSlug: env.PRINT_AGENT_ORG_SLUG,
    workstationCode: env.PRINT_AGENT_WORKSTATION_CODE,
    actorEmail: env.PRINT_AGENT_ACTOR_EMAIL,
  });

  const transport = createZplTransport({
    mode: env.PRINT_AGENT_ZPL_MODE,
    filePath: env.PRINT_AGENT_ZPL_FILE_PATH,
    host: env.PRINT_AGENT_PRINTER_HOST,
    port: env.PRINT_AGENT_PRINTER_PORT,
    timeoutMs: env.PRINT_AGENT_PRINTER_TIMEOUT_MS,
  });

  logger.info("print-agent.boot", {
    nodeEnv: env.NODE_ENV,
    pid: process.pid,
    organizationId: runtime.organizationId,
    workstationId: runtime.workstationId,
    actorUserId: runtime.actorUserId,
    zplMode: env.PRINT_AGENT_ZPL_MODE,
    pollIntervalMs: env.PRINT_AGENT_POLL_INTERVAL_MS,
  });

  let baseTenancy = runtime.tenancy;

  const pollLoop = createPollLoop({
    name: "sent-print-jobs",
    intervalMs: env.PRINT_AGENT_POLL_INTERVAL_MS,
    logger,
    tick: async () => {
      const result = await processNextSentPrintJob({
        client: prisma,
        transport,
        logger,
        organizationId: runtime.organizationId,
        workstationId: runtime.workstationId,
        buildTenancy: () => refreshTenancyCorrelation(baseTenancy),
      });
      if (result.processed) {
        baseTenancy = refreshTenancyCorrelation(baseTenancy);
        logger.info("print-agent.job.processed", {
          printJobId: result.printJobId,
          outcome: result.outcome,
        });
      }
    },
  });

  pollLoop.start();

  // Liveness marker for the ECS/Fargate container health check
  // (`test -f /tmp/pharmax-print-agent-alive` in
  // infra/terraform/modules/ecs/main.tf). Started AFTER the poll loop is
  // running so the task only reports healthy once it has actually booted;
  // the marker is removed during shutdown below.
  const livenessHeartbeat = createLivenessHeartbeat({ logger });
  await livenessHeartbeat.start();

  await waitForShutdown({
    pollLoop,
    livenessHeartbeat,
    runtime,
    shutdownTimeoutMs: env.PRINT_AGENT_SHUTDOWN_TIMEOUT_MS,
  });
}

async function waitForShutdown(input: {
  pollLoop: { stop(): Promise<void> };
  livenessHeartbeat: { stop(): Promise<void> };
  runtime: PrintAgentRuntimeContext;
  shutdownTimeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolve) => {
    let shuttingDown = false;

    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.info("print-agent.shutdown", { signal });

      const forceExit = setTimeout(() => {
        logger.error("print-agent.shutdown.timeout", {
          shutdownTimeoutMs: input.shutdownTimeoutMs,
        });
        process.exit(1);
      }, input.shutdownTimeoutMs);
      forceExit.unref();

      void (async () => {
        // Remove the liveness marker first so a draining task fails its
        // ECS health check immediately instead of lingering as healthy.
        await input.livenessHeartbeat.stop();
        await input.pollLoop.stop();
        clearTimeout(forceExit);
        await prisma.$disconnect();
        await flushSentry(2_000);
        if (telemetryHandle !== null) {
          await telemetryHandle.shutdown();
        }
        logger.info("print-agent.shutdown.complete");
        resolve();
      })();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

main().catch((error: unknown) => {
  logger.error("print-agent.fatal", {
    errorMessage: error instanceof Error ? error.message : "unknown",
  });
  process.exit(1);
});
