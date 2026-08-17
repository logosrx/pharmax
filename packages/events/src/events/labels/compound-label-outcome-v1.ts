// labels.compound_label.completed.v1 / .failed.v1 — terminal outcome of
// a compound stock label print job, reported by the workstation print
// agent after the physical send and the printer status check.
//
// Separate from the `labels.vial_print.*` family because those declare
// orderId/orderLineId as required UUIDs — correct for a patient vial,
// impossible for a batch that predates any order.
//
// The FAILED event is the audit trail behind "no silent printer
// failures": a jam, paper-out, or an unparseable `~HS` status response
// all land here rather than being swallowed. For a unit label the event
// names the specific unit, so a failure is attributable to the vial
// whose label did not print.
//
// PHI-safe: batch and unit identity only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const basePayload = {
  printJobId: z.uuid(),
  organizationId: z.uuid(),
  targetKind: z.enum(["COMPOUND_BATCH", "COMPOUND_UNIT"]),
  compoundBatchId: z.uuid(),
  /** Present only for COMPOUND_UNIT. */
  compoundBatchUnitId: z.uuid().optional(),
  workstationId: z.uuid().nullable(),
  occurredAt: z.iso.datetime({ offset: true }),
};

const completedSchema = z.object({ ...basePayload, status: z.literal("COMPLETED") }).strict();

const failedSchema = z.object({ ...basePayload, status: z.literal("FAILED") }).strict();

export const LabelsCompoundLabelCompletedV1 = defineEvent({
  name: "labels.compound_label.completed",
  version: 1,
  aggregateType: "PrintJob",
  schema: completedSchema,
  aggregateIdFrom: (p) => p.printJobId,
  owner: "labels",
  retention: "7y",
  phiSafe: true,
  routingKey: "labels.compound_label",
  description:
    "Emitted when the print agent confirms a compound stock label physically printed and the printer reported ready. For a unit label this is the record that that specific vial's serial reached a label.",
});

export const LabelsCompoundLabelFailedV1 = defineEvent({
  name: "labels.compound_label.failed",
  version: 1,
  aggregateType: "PrintJob",
  schema: failedSchema,
  aggregateIdFrom: (p) => p.printJobId,
  owner: "labels",
  retention: "7y",
  phiSafe: true,
  routingKey: "labels.compound_label",
  description:
    "Emitted when a compound stock label print job fails — transport error, printer not ready, or an unparseable status response. The failure reason stays on print_job.failureReason; this event is the signal that a label did NOT reach the vial or batch it was meant for.",
});

export type LabelsCompoundLabelCompletedV1Payload = z.infer<typeof completedSchema>;
export type LabelsCompoundLabelFailedV1Payload = z.infer<typeof failedSchema>;
