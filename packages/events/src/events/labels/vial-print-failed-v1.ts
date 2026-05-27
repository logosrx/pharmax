// labels.vial_print.failed.v1 — workstation agent reported a print failure.
//
// Producer: `ConfirmVialLabelPrint` (`@pharmax/labels`), FAILED
//   branch. Workstation agent posts the callback when the print
//   could not fire (printer offline, jam, communication failure,
//   etc.). The free-text `failureReason` is REDACTED from the
//   command_log and NEVER appears in this payload — only the fact
//   of failure does.
// Consumers: fill-workbench projection (surface "print failed,
//   reprint required" banner); print-printer-health dashboard.
//
// PHI: none. Ids + status only; failure reason is excluded.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    printJobId: z.uuid(),
    organizationId: z.uuid(),
    orderId: z.uuid(),
    orderLineId: z.uuid(),
    /** Always the literal `"FAILED"` on this event. */
    status: z.literal("FAILED"),
    workstationId: z.uuid().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const LabelsVialPrintFailedV1 = defineEvent({
  name: "labels.vial_print.failed",
  version: 1,
  aggregateType: "PrintJob",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.printJobId,
  owner: "labels",
  retention: "7y",
  phiSafe: true,
  routingKey: "labels.print",
  description:
    "Emitted by ConfirmVialLabelPrint's FAILED branch when the workstation agent reports the print could not fire. The free-text failure reason is redacted and not in the payload.",
});

export type LabelsVialPrintFailedV1Payload = z.infer<typeof payloadSchema>;
