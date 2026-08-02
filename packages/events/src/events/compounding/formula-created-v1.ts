// compounding.formula.created.v1 — a new compound formula version
// (Master Formulation Record, USP <795>/<797>) was drafted.
//
// Producer: `CreateCompoundFormula` (`@pharmax/compounding`).
// Consumers: formulary catalog projections; downstream systems that
//   track which recipes an org is authoring.
//
// PHI-safe: the payload is recipe/catalog identity only.

import { z } from "zod";

import { defineEvent } from "../../define-event.js";

const payloadSchema = z
  .object({
    formulaId: z.uuid(),
    organizationId: z.uuid(),
    code: z.string(),
    version: z.number().int().positive(),
    preparationKind: z.enum(["NONSTERILE", "STERILE"]),
    /** USP <800>: preparation involves a hazardous (NIOSH list) drug. */
    hazardous: z.boolean(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const CompoundingFormulaCreatedV1 = defineEvent({
  name: "compounding.formula.created",
  version: 1,
  aggregateType: "CompoundFormula",
  schema: payloadSchema,
  aggregateIdFrom: (p) => p.formulaId,
  owner: "compounding",
  retention: "7y",
  phiSafe: true,
  routingKey: "compounding.formulary",
  description:
    "Emitted by CreateCompoundFormula when a new Master Formulation Record version is drafted (ADR-0035). Recipe identity only — no PHI.",
});

export type CompoundingFormulaCreatedV1Payload = z.infer<typeof payloadSchema>;
