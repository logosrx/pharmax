// compounding.formula.retired.v1 — an ACTIVE formula version was
// retired outside the normal supersede-on-publish path (safety pull,
// formulary change, sourcing problem, regulatory action, or authored
// in error).
//
// Producer: `RetireCompoundFormula` (`@pharmax/compounding`).
// Consumers: formulary catalog projections; slice-2 preparation
//   surfaces (a retired formula must stop being offered immediately).

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    formulaId: z.uuid(),
    organizationId: z.uuid(),
    code: z.string(),
    version: z.number().int().positive(),
    retiredByUserId: z.uuid(),
    reasonCode: z.enum([
      "SAFETY",
      "FORMULARY_CHANGE",
      "INGREDIENT_SOURCING",
      "REGULATORY",
      "ERROR",
    ]),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const CompoundingFormulaRetiredV1 = defineEvent({
  name: "compounding.formula.retired",
  version: 1,
  aggregateType: "CompoundFormula",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.formulaId,
  owner: "compounding",
  retention: "7y",
  phiSafe: true,
  routingKey: "compounding.formulary",
  description:
    "Emitted by RetireCompoundFormula when an ACTIVE Master Formulation Record is retired with a closed reason code (ADR-0035).",
});

export type CompoundingFormulaRetiredV1Payload = z.infer<typeof payloadSchema>;
