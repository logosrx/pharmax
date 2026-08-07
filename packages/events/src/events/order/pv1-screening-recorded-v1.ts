// order.pv1.screening.recorded.v1 — a PV1 clinical screen ran and its
// findings were persisted.
//
// Producers: `StartPV1` (phase PV1_START, the snapshot the console
//   renders) and `ApprovePV1` (phase PV1_APPROVE, the re-screen the
//   approval was actually gated on).
// Consumers: the PV1 console (renders findings alongside the order);
//   alert-fatigue reporting (override rates by finding code, which is
//   the metric that decides whether the tiers are set correctly).
//
// The payload carries each finding's identity and grading but NOT its
// `reason`, `triggers` or `citation` — see `projection.ts` in
// `@pharmax/verification` for why the outbox surface is narrower than
// the persisted row. `gapCount` is exposed at the top level because
// "how much of the screen could not be run" is a different question
// from "how risky is this prescription", and a consumer that cannot
// distinguish them will report unscreened orders as clean.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const findingSchema = z
  .object({
    code: z.string().min(1),
    kind: z.string().min(1),
    severity: z.string().min(1),
    certainty: z.string().min(1),
    disposition: z.string().min(1),
    fingerprint: z.string().min(1),
  })
  .strict();

const payloadSchema = z
  .object({
    orderId: z.uuid(),
    organizationId: z.uuid(),
    siteId: z.uuid(),
    pharmacistUserId: z.uuid(),
    phase: z.enum(["PV1_START", "PV1_APPROVE"]),
    outcome: z.enum(["CLEAR", "ADVISORY", "BLOCKED"]),
    screenedLineCount: z.number().int().nonnegative(),
    findingCount: z.number().int().nonnegative(),
    hardStopCount: z.number().int().nonnegative(),
    requiresAcknowledgementCount: z.number().int().nonnegative(),
    informationalCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    findings: z.array(findingSchema),
    workflowPolicyId: z.uuid(),
    workflowPolicyVersion: z.number().int().positive(),
    minimumReportedSeverity: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OrderPv1ScreeningRecordedV1 = defineEvent({
  name: "order.pv1.screening.recorded",
  version: 1,
  aggregateType: "Order",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.orderId,
  owner: "verification",
  retention: "7y",
  phiSafe: true,
  routingKey: "order.lifecycle",
  description:
    "Emitted by StartPV1 and ApprovePV1 when a clinical screen runs. Carries finding codes, gradings and fingerprints — no drug names, no patient identifiers, no free text. `gapCount` reports checks that could not be performed.",
});

export type OrderPv1ScreeningRecordedV1Payload = z.infer<typeof payloadSchema>;
