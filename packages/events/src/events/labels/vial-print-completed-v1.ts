// labels.vial_print.completed.v1 — workstation agent confirmed the vial label printed.
//
// Producer: `ConfirmVialLabelPrint` (`@pharmax/labels`), COMPLETED
//   branch. The workstation agent posts the callback after the
//   thermal print actually fires on the physical printer.
// Consumers: fill-workbench projection (advance the line to
//   "printed"); CompleteFill's prerequisite check reads the
//   resulting print_job row in COMPLETED.
//
// PHI: none. Ids + status only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    printJobId: z.uuid(),
    organizationId: z.uuid(),
    orderId: z.uuid(),
    orderLineId: z.uuid(),
    /**
     * Always the literal `"COMPLETED"` on this event. The status
     * appears in the payload (vs. being derivable from the event
     * name) so a single union projector can read it off both
     * `completed` and `failed` events.
     */
    status: z.literal("COMPLETED"),
    workstationId: z.uuid().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const LabelsVialPrintCompletedV1 = defineEvent({
  name: "labels.vial_print.completed",
  version: 1,
  aggregateType: "PrintJob",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.printJobId,
  owner: "labels",
  retention: "7y",
  phiSafe: true,
  routingKey: "labels.print",
  description:
    "Emitted by ConfirmVialLabelPrint's COMPLETED branch after the workstation agent confirms the print fired on the physical printer.",
});

export type LabelsVialPrintCompletedV1Payload = z.infer<typeof payloadSchema>;
