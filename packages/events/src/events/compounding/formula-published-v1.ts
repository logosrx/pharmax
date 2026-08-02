// compounding.formula.published.v1 — a DRAFT formula version went
// ACTIVE and became the org's authoritative recipe for its code.
//
// Producer: `PublishCompoundFormula` (`@pharmax/compounding`).
// Consumers: formulary catalog projections; slice-2 preparation
//   surfaces that only offer ACTIVE formulas.
//
// `supersededFormulaId` is set when publishing retired a previously
// ACTIVE version of the same code in the same transaction.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    formulaId: z.uuid(),
    organizationId: z.uuid(),
    code: z.string(),
    version: z.number().int().positive(),
    publishedByUserId: z.uuid(),
    /** Prior ACTIVE version retired by this publish, when one existed. */
    supersededFormulaId: z.uuid().nullable(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const CompoundingFormulaPublishedV1 = defineEvent({
  name: "compounding.formula.published",
  version: 1,
  aggregateType: "CompoundFormula",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.formulaId,
  owner: "compounding",
  retention: "7y",
  phiSafe: true,
  routingKey: "compounding.formulary",
  description:
    "Emitted by PublishCompoundFormula when a Master Formulation Record version goes ACTIVE (ADR-0035). Publishing retires the prior ACTIVE version of the same code, recorded as supersededFormulaId.",
});

export type CompoundingFormulaPublishedV1Payload = z.infer<typeof payloadSchema>;
