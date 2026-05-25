import { prisma } from "@pharmax/database";

import { bootstrap } from "./bootstrap.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { flushSentry } from "./observability/sentry-init.js";
import { createZplTransport } from "./printer/send-zpl.js";
import { processNextSentPrintJob, refreshTenancyCorrelation } from "./process-sent-print-job.js";
import { createPollLoop } from "./runtime/poll-loop.js";
import {
  resolvePrintAgentRuntimeContext,
  type PrintAgentRuntimeContext,
} from "./resolve-runtime-context.js";

async function main(): Promise<void> {
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

  await waitForShutdown({
    pollLoop,
    runtime,
    shutdownTimeoutMs: env.PRINT_AGENT_SHUTDOWN_TIMEOUT_MS,
  });
}

async function waitForShutdown(input: {
  pollLoop: { stop(): Promise<void> };
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

      void input.pollLoop.stop().finally(async () => {
        clearTimeout(forceExit);
        await prisma.$disconnect();
        await flushSentry(2_000);
        logger.info("print-agent.shutdown.complete");
        resolve();
      });
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
