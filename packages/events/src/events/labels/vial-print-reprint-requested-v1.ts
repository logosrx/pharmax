// labels.vial_print.reprint_requested.v1 — operator asked to reprint a vial label.
//
// Producer: `ReprintVialLabel` (`@pharmax/fill`).
// Consumers: same `dispatchVialPrintJob` outbox handler as
//   `labels.vial_print.requested.v1`. The reason code differentiates
//   reprints in the print-job-history report and pins the "No
//   silent label reprints" workflow-safety rule.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const VIAL_LABEL_REPRINT_REASONS = [
  "LABEL_DAMAGED",
  "PRINTER_JAM",
  "WRONG_LABEL_APPLIED",
  "BARCODE_UNREADABLE",
  "TEMPLATE_MISALIGNMENT",
  "OTHER",
] as const;

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    orderId: z.uuid(),
    orderLineId: z.uuid(),
    printJobId: z.uuid(),
    vialLabelId: z.uuid(),
    reprintReasonCode: z.enum(VIAL_LABEL_REPRINT_REASONS),
    printerId: z.uuid(),
    workstationId: z.uuid().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const LabelsVialPrintReprintRequestedV1 = defineEvent({
  name: "labels.vial_print.reprint_requested",
  version: 1,
  aggregateType: "PrintJob",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.printJobId,
  owner: "labels",
  retention: "7y",
  phiSafe: true,
  routingKey: "labels.print",
  description:
    "Emitted by ReprintVialLabel for every operator-initiated reprint. The reason code is mandatory (workflow-safety: no silent label reprints) and lands in the print-job-history report.",
});

export type LabelsVialPrintReprintRequestedV1Payload = z.infer<typeof payloadSchema>;
