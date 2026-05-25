import { describe, expect, it, vi } from "vitest";

import { LabelPrinterConnection, PrintJobStatus } from "@pharmax/database";
import { logger as loggerNs } from "@pharmax/platform-core";

import {
  dispatchVialPrintJob,
  VialPrintJobNotDeliverableError,
  VialPrintJobNotFoundError,
  type PrintJobClient,
  type VialPrintDeliveryPort,
} from "./dispatch-vial-print-job.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PRINT_JOB_ID = "22222222-2222-4222-8222-222222222222";
const PRINTER_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_LINE_ID = "55555555-5555-4555-8555-555555555555";
const WORKSTATION_ID = "66666666-6666-4666-8666-666666666666";

function buildClient(overrides: {
  job?: Record<string, unknown> | null;
  printer?: Record<string, unknown> | null;
}) {
  const printJobUpdate = vi.fn(async () => ({ id: PRINT_JOB_ID }));

  return {
    client: {
      printJob: {
        findFirst: vi.fn(async () => overrides.job ?? null),
        update: printJobUpdate,
      },
      labelPrinter: {
        findFirst: vi.fn(async () => overrides.printer ?? null),
      },
    } as PrintJobClient,
    printJobUpdate,
  };
}

const pendingJob = {
  id: PRINT_JOB_ID,
  organizationId: ORG_ID,
  orderId: ORDER_ID,
  orderLineId: ORDER_LINE_ID,
  printerId: PRINTER_ID,
  workstationId: WORKSTATION_ID,
  status: PrintJobStatus.PENDING,
  renderedZpl: "^XA^FDdemo^XZ",
  isReprint: false,
  reprintReasonCode: null,
};

const activePrinter = {
  id: PRINTER_ID,
  connection: LabelPrinterConnection.WORKSTATION_AGENT,
  networkAddress: null,
  status: "ACTIVE",
};

describe("dispatchVialPrintJob", () => {
  it("marks PENDING job SENT and invokes delivery port", async () => {
    const { client, printJobUpdate } = buildClient({
      job: pendingJob,
      printer: activePrinter,
    });
    const deliver = vi.fn(async () => undefined);
    const delivery: VialPrintDeliveryPort = { deliver };

    const result = await dispatchVialPrintJob({
      client,
      delivery,
      logger: loggerNs.noopLogger,
      organizationId: ORG_ID,
      printJobId: PRINT_JOB_ID,
      contentHashHex: "abc123",
    });

    expect(result).toEqual({
      printJobId: PRINT_JOB_ID,
      previousStatus: PrintJobStatus.PENDING,
      newStatus: PrintJobStatus.SENT,
      idempotent: false,
    });
    expect(printJobUpdate).toHaveBeenCalledWith({
      where: { id: PRINT_JOB_ID },
      data: { status: PrintJobStatus.SENT },
    });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        printJobId: PRINT_JOB_ID,
        renderedZpl: "^XA^FDdemo^XZ",
        printerConnection: LabelPrinterConnection.WORKSTATION_AGENT,
      })
    );
  });

  it("is idempotent when job is already SENT", async () => {
    const { client, printJobUpdate } = buildClient({
      job: { ...pendingJob, status: PrintJobStatus.SENT },
      printer: activePrinter,
    });
    const deliver = vi.fn(async () => undefined);

    const result = await dispatchVialPrintJob({
      client,
      delivery: { deliver },
      logger: loggerNs.noopLogger,
      organizationId: ORG_ID,
      printJobId: PRINT_JOB_ID,
    });

    expect(result.idempotent).toBe(true);
    expect(printJobUpdate).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("throws when print job is missing", async () => {
    const { client } = buildClient({ job: null });

    await expect(
      dispatchVialPrintJob({
        client,
        delivery: { deliver: vi.fn() },
        logger: loggerNs.noopLogger,
        organizationId: ORG_ID,
        printJobId: PRINT_JOB_ID,
      })
    ).rejects.toBeInstanceOf(VialPrintJobNotFoundError);
  });

  it("throws when job is not PENDING or SENT", async () => {
    const { client } = buildClient({
      job: { ...pendingJob, status: PrintJobStatus.COMPLETED },
      printer: activePrinter,
    });

    await expect(
      dispatchVialPrintJob({
        client,
        delivery: { deliver: vi.fn() },
        logger: loggerNs.noopLogger,
        organizationId: ORG_ID,
        printJobId: PRINT_JOB_ID,
      })
    ).rejects.toBeInstanceOf(VialPrintJobNotDeliverableError);
  });
});
