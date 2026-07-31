import { executeCommand } from "@pharmax/command-bus";
import type { PrismaClient } from "@pharmax/database";
import { ConfirmVialLabelPrint } from "@pharmax/labels";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { withSpan } from "@pharmax/telemetry";
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
  // Consumer span resuming the requesting command's trace via the
  // traceparent persisted on the print_job row — this is the third
  // service in the web → worker → print-agent chain. Attributes are
  // ids only; the rendered ZPL is label content (PHI) and must NEVER
  // appear in span attributes, names, or events.
  return withSpan(
    {
      tracerName: "pharmacy-print-agent",
      spanName: "print_job.process",
      kind: "consumer",
      parentTraceparent: job.traceparent,
      attributes: {
        "pharmax.print_job_id": job.id,
        "pharmax.printer_id": job.printerId,
        "pharmax.order_id": job.orderId,
      },
    },
    async (span) => {
      const result = await processSentPrintJobInner(deps, job);
      if (result.outcome !== undefined) {
        span.setAttribute("pharmax.print_job.outcome", result.outcome);
      }
      return result;
    }
  );
}

async function processSentPrintJobInner(
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
    // Manual client span: the ZPL send is a raw TCP socket (or file)
    // write — the `net` auto-instrumentation is disabled, so this is
    // the only visibility into the printer I/O itself.
    await withSpan(
      {
        tracerName: "pharmacy-print-agent",
        spanName: "zpl.send",
        kind: "client",
        attributes: {
          "pharmax.print_job_id": job.id,
          "pharmax.printer_id": job.printerId,
        },
      },
      () => deps.transport.send(job.renderedZpl)
    );
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

  // "No silent printer failures": a successful socket write proves
  // only that the printer's controller accepted bytes — a Zebra out
  // of labels, paused, or with the head open still ACKs the write.
  // When the transport can query printer status (~HS on TCP), a
  // fault flag downgrades this job to FAILED with the fault list so
  // the tech re-prints instead of the system recording a label that
  // physically does not exist.
  if (deps.transport.verifyPrinterReady !== undefined) {
    let failureReason: string | null = null;
    try {
      const status = await deps.transport.verifyPrinterReady();
      if (!status.ready) {
        failureReason = `printer reported fault after send: ${status.faults.join(", ")}`;
      }
    } catch (error) {
      failureReason = `printer status verification failed: ${sanitizeFailureReason(error)}`;
    }
    if (failureReason !== null) {
      log.error("print-agent.printer.not_ready", { failureReason, printerId: job.printerId });
      await confirmWithRetry({
        tenancy,
        printJobId: job.id,
        status: "FAILED",
        failureReason: failureReason.slice(0, 500),
        logger: log,
      });
      return { processed: true, printJobId: job.id, outcome: "failed" };
    }
    log.info("print-agent.printer.verified_ready", { printerId: job.printerId });
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
