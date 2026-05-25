// Worker-side handoff for thermal vial print jobs.
//
// Called from outbox handlers for `labels.vial_print.requested.v1` and
// `labels.vial_print.reprint_requested.v1`. Does NOT mutate workflow
// state — only advances `print_job` PENDING → SENT and invokes the
// delivery port (workstation agent or raw network adapter).
//
// PHI rule: never log `renderedZpl`. Logs use printJobId + contentHash
// hex from the outbox payload when available.

import { PrintJobStatus, type LabelPrinterConnection } from "@pharmax/database";
import type { logger as loggerContract } from "@pharmax/platform-core";

type Logger = loggerContract.Logger;

export interface VialPrintDeliveryInput {
  readonly printJobId: string;
  readonly organizationId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly workstationId: string | null;
  readonly printerId: string;
  readonly printerConnection: LabelPrinterConnection;
  readonly networkAddress: string | null;
  readonly renderedZpl: string;
  readonly isReprint: boolean;
  readonly reprintReasonCode: string | null;
}

export interface VialPrintDeliveryPort {
  deliver(input: VialPrintDeliveryInput): Promise<void>;
}

export const noopVialPrintDelivery: VialPrintDeliveryPort = {
  async deliver(): Promise<void> {
    // Placeholder until apps/print-agent subscribes or polls SENT jobs.
  },
};

export class VialPrintJobNotFoundError extends Error {
  readonly code = "VIAL_PRINT_JOB_NOT_FOUND" as const;
  constructor(readonly printJobId: string) {
    super(`Print job not found: ${printJobId}`);
    this.name = "VialPrintJobNotFoundError";
  }
}

export class VialPrintJobNotDeliverableError extends Error {
  readonly code = "VIAL_PRINT_JOB_NOT_DELIVERABLE" as const;
  constructor(
    readonly printJobId: string,
    readonly status: PrintJobStatus
  ) {
    super(`Print job ${printJobId} is not deliverable (status=${status}).`);
    this.name = "VialPrintJobNotDeliverableError";
  }
}

type PrintJobClient = {
  readonly printJob: {
    findFirst(args: unknown): Promise<LoadedPrintJob | null>;
    update(args: unknown): Promise<unknown>;
  };
  readonly labelPrinter: {
    findFirst(args: unknown): Promise<LoadedPrinter | null>;
  };
};

export type { PrintJobClient };

export interface DispatchVialPrintJobInput {
  readonly client: PrintJobClient;
  readonly delivery: VialPrintDeliveryPort;
  readonly logger: Logger;
  readonly organizationId: string;
  readonly printJobId: string;
  readonly contentHashHex?: string;
}

export interface DispatchVialPrintJobResult {
  readonly printJobId: string;
  readonly previousStatus: PrintJobStatus;
  readonly newStatus: PrintJobStatus;
  readonly idempotent: boolean;
}

function selectPrintJobFields() {
  return {
    id: true,
    organizationId: true,
    orderId: true,
    orderLineId: true,
    printerId: true,
    workstationId: true,
    status: true,
    renderedZpl: true,
    isReprint: true,
    reprintReasonCode: true,
  } as const;
}

type LoadedPrintJob = {
  readonly id: string;
  readonly organizationId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly printerId: string;
  readonly workstationId: string | null;
  readonly status: PrintJobStatus;
  readonly renderedZpl: string;
  readonly isReprint: boolean;
  readonly reprintReasonCode: string | null;
};

type LoadedPrinter = {
  readonly id: string;
  readonly connection: LabelPrinterConnection;
  readonly networkAddress: string | null;
  readonly status: string;
};

export async function dispatchVialPrintJob(
  input: DispatchVialPrintJobInput
): Promise<DispatchVialPrintJobResult> {
  const job = await input.client.printJob.findFirst({
    where: { id: input.printJobId, organizationId: input.organizationId },
    select: selectPrintJobFields(),
  });

  if (job === null) {
    throw new VialPrintJobNotFoundError(input.printJobId);
  }

  if (job.status === PrintJobStatus.SENT) {
    input.logger.info("vial_print.dispatch.idempotent_sent", {
      printJobId: job.id,
      organizationId: job.organizationId,
      contentHashHex: input.contentHashHex,
    });
    return {
      printJobId: job.id,
      previousStatus: PrintJobStatus.SENT,
      newStatus: PrintJobStatus.SENT,
      idempotent: true,
    };
  }

  if (job.status !== PrintJobStatus.PENDING) {
    throw new VialPrintJobNotDeliverableError(job.id, job.status);
  }

  const printer = await input.client.labelPrinter.findFirst({
    where: { id: job.printerId, organizationId: job.organizationId },
    select: { id: true, connection: true, networkAddress: true, status: true },
  });

  if (printer === null) {
    throw new VialPrintJobNotFoundError(input.printJobId);
  }

  await input.client.printJob.update({
    where: { id: job.id },
    data: { status: PrintJobStatus.SENT },
  });

  await input.delivery.deliver({
    printJobId: job.id,
    organizationId: job.organizationId,
    orderId: job.orderId,
    orderLineId: job.orderLineId,
    workstationId: job.workstationId,
    printerId: printer.id,
    printerConnection: printer.connection,
    networkAddress: printer.networkAddress,
    renderedZpl: job.renderedZpl,
    isReprint: job.isReprint,
    reprintReasonCode: job.reprintReasonCode,
  });

  input.logger.info("vial_print.dispatch.sent", {
    printJobId: job.id,
    organizationId: job.organizationId,
    orderId: job.orderId,
    orderLineId: job.orderLineId,
    printerId: printer.id,
    workstationId: job.workstationId,
    printerConnection: printer.connection,
    isReprint: job.isReprint,
    reprintReasonCode: job.reprintReasonCode,
    contentHashHex: input.contentHashHex,
  });

  return {
    printJobId: job.id,
    previousStatus: PrintJobStatus.PENDING,
    newStatus: PrintJobStatus.SENT,
    idempotent: false,
  };
}

export type { LoadedPrintJob, LoadedPrinter };
