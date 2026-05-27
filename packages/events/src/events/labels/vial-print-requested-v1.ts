// labels.vial_print.requested.v1 — server-side ZPL rendered, print job dispatch queued.
//
// Producer: `PrintVialLabel` (`@pharmax/fill`).
// Consumers: `dispatchVialPrintJob` outbox handler in
//   `apps/worker/src/drains/dispatch-vial-print-job.ts` — advances
//   `print_job` PENDING → SENT and dispatches to the workstation
//   agent or raw network printer.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    organizationId: z.uuid(),
    orderId: z.uuid(),
    orderLineId: z.uuid(),
    printJobId: z.uuid(),
    vialLabelId: z.uuid(),
    printerId: z.uuid(),
    /**
     * Workstation that initiated the print. Null when the source
     * is a non-workstation context (e.g. a backfill job).
     */
    workstationId: z.uuid().nullable(),
    /** Pharmax-internal template code (e.g. `default.zebra-zd420`). */
    templateCode: z.string().min(1).max(64),
    /** Template version stamp. */
    templateVersion: z.number().int().min(1),
    /**
     * Lowercase hex SHA256 of the rendered ZPL bytes. The worker
     * uses this to detect tampering between render and delivery
     * (the bytes are stored in S3; the hash is the verification
     * seam).
     */
    contentHashHex: z.string().regex(/^[a-f0-9]{64}$/),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const LabelsVialPrintRequestedV1 = defineEvent({
  name: "labels.vial_print.requested",
  version: 1,
  aggregateType: "PrintJob",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.printJobId,
  owner: "labels",
  retention: "7y",
  phiSafe: true,
  routingKey: "labels.print",
  description:
    "Emitted by PrintVialLabel once the ZPL render succeeds and a PrintJob row in PENDING is persisted. Drives the worker-side dispatch + workstation agent handoff.",
});

export type LabelsVialPrintRequestedV1Payload = z.infer<typeof payloadSchema>;
