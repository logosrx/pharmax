import { executeCommand } from "@pharmax/command-bus";
import type { PrismaClient } from "@pharmax/database";
import { ConfirmVialLabelPrint } from "@pharmax/labels";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { withTenancyContext, type TenancyContext } from "@pharmax/tenancy";
import { ulid } from "ulid";

import { claimNextSentPrintJob, type ClaimedSentPrintJob } from "./claim-sent-print-job.js";
import type { ZplTransport } from "./printer/send-zpl.js";

type Logger = loggerContract.Logger;

const CONFIRM_MAX_ATTEMPTS = 3;
const CONFIRM_RETRY_DELAY_MS = 500;

export interface ProcessSentPrintJobDeps {
  readonly client: PrismaClient;
  readonly transport: ZplTransport;
  readonly logger: Logger;
  readonly organizationId: string;
  readonly workstationId: string;
  readonly buildTenancy: () => TenancyContext;
}

export interface ProcessSentPrintJobResult {
  readonly processed: boolean;
  readonly printJobId?: string;
  readonly outcome?: "completed" | "failed";
}

function sanitizeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown print transport error";
  return message.slice(0, 500);
}

async function confirmPrintJob(input: {
  tenancy: TenancyContext;
  printJobId: string;
  status: "COMPLETED" | "FAILED";
  failureReason?: string;
}): Promise<void> {
  await withTenancyContext(input.tenancy, async () => {
    await executeCommand(
      ConfirmVialLabelPrint,
      {
        printJobId: input.printJobId,
        status: input.status,
        ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
      },
      { idempotencyKey: `confirm-print:${input.printJobId}` }
    );
  });
}

async function confirmWithRetry(input: {
  tenancy: TenancyContext;
  printJobId: string;
  status: "COMPLETED" | "FAILED";
  failureReason?: string;
  logger: Logger;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONFIRM_MAX_ATTEMPTS; attempt += 1) {
    try {
      await confirmPrintJob(input);
      return;
    } catch (error) {
      lastError = error;
      input.logger.warn("print-agent.confirm.retry", {
        printJobId: input.printJobId,
        attempt,
        errorMessage: error instanceof Error ? error.message : "unknown",
      });
      if (attempt < CONFIRM_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, CONFIRM_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

export async function processSentPrintJob(
  deps: ProcessSentPrintJobDeps,
  job: ClaimedSentPrintJob
): Promise<ProcessSentPrintJobResult> {
  const log = deps.logger.child({
    component: "process-sent-print-job",
    printJobId: job.id,
    orderId: job.orderId,
    orderLineId: job.orderLineId,
  });

  const tenancy = deps.buildTenancy();

  try {
    await deps.transport.send(job.renderedZpl);
    log.info("print-agent.zpl.sent", { printerId: job.printerId });
  } catch (error) {
    const failureReason = sanitizeFailureReason(error);
    log.error("print-agent.zpl.failed", { failureReason });
    await confirmWithRetry({
      tenancy,
      printJobId: job.id,
      status: "FAILED",
      failureReason,
      logger: log,
    });
    return { processed: true, printJobId: job.id, outcome: "failed" };
  }

  await confirmWithRetry({
    tenancy,
    printJobId: job.id,
    status: "COMPLETED",
    logger: log,
  });
  log.info("print-agent.print.confirmed", { status: "COMPLETED" });
  return { processed: true, printJobId: job.id, outcome: "completed" };
}

export async function processNextSentPrintJob(
  deps: ProcessSentPrintJobDeps
): Promise<ProcessSentPrintJobResult> {
  const job = await claimNextSentPrintJob(deps.client, {
    organizationId: deps.organizationId,
    workstationId: deps.workstationId,
  });
  if (job === null) {
    return { processed: false };
  }
  return processSentPrintJob(deps, job);
}

/** @internal test helper — fresh correlation id per command attempt */
export function refreshTenancyCorrelation(base: TenancyContext): TenancyContext {
  return {
    ...base,
    actor: {
      userId: base.actor.userId,
      correlationId: ulid(),
    },
  };
}
