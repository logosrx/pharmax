// RetireCompoundFormula — pull an ACTIVE Master Formulation Record
// out of service with a closed reason code (ADR-0035).
//
// This is the out-of-band retirement path (safety pull, formulary
// change, sourcing problem, regulatory action, authored in error) —
// distinct from the automatic supersede that PublishCompoundFormula
// performs, which records no reason code. Per the workflow-safety
// house rule ("every rejection/hold/cancellation carries a reason"),
// every explicit retirement carries one.
//
// Retirement is terminal for the VERSION, not the code: drafting and
// publishing a new version of the same code remains possible.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { CompoundFormulaRetireReason, CompoundFormulaStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import { COMPOUND_FORMULA_INVALID_STATE, COMPOUND_FORMULA_NOT_FOUND } from "../shared.js";

const inputSchema = z
  .object({
    formulaId: z.uuid(),
    reasonCode: z.enum(CompoundFormulaRetireReason),
  })
  .strict();

export type RetireCompoundFormulaInput = z.infer<typeof inputSchema>;

export interface RetireCompoundFormulaOutput {
  readonly formulaId: string;
  readonly code: string;
  readonly version: number;
  readonly status: "RETIRED";
}

export const RetireCompoundFormula: Command<
  RetireCompoundFormulaInput,
  RetireCompoundFormulaOutput
> = {
  name: "RetireCompoundFormula",
  inputSchema,
  permission: PERMISSIONS.COMPOUNDING_FORMULA_MANAGE,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<RetireCompoundFormulaOutput>> {
    const formula = await tx.compoundFormula.findUnique({
      where: { id: input.formulaId },
      select: { id: true, code: true, version: true, status: true },
    });
    if (formula === null) {
      throw new errors.NotFoundError({
        code: COMPOUND_FORMULA_NOT_FOUND,
        message: "Compound formula not found.",
        metadata: { formulaId: input.formulaId },
      });
    }
    if (formula.status !== CompoundFormulaStatus.ACTIVE) {
      throw new errors.ConflictError({
        code: COMPOUND_FORMULA_INVALID_STATE,
        message: `Formula is ${formula.status}; only ACTIVE versions can be retired.`,
        metadata: { formulaId: formula.id, status: formula.status },
      });
    }

    const now = clock.now();
    await tx.compoundFormula.update({
      where: { id: formula.id },
      data: {
        status: CompoundFormulaStatus.RETIRED,
        retiredAt: now,
        retiredReason: input.reasonCode,
      },
      select: { id: true },
    });

    return {
      output: {
        formulaId: formula.id,
        code: formula.code,
        version: formula.version,
        status: "RETIRED",
      },
      audit: {
        action: "compounding.formula.retired",
        resourceType: "CompoundFormula",
        resourceId: formula.id,
        metadata: {
          code: formula.code,
          version: formula.version,
          reasonCode: input.reasonCode,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "compounding.formula.retired.v1",
          aggregateType: "CompoundFormula",
          aggregateId: formula.id,
          payload: {
            formulaId: formula.id,
            organizationId: ctx.organizationId,
            code: formula.code,
            version: formula.version,
            retiredByUserId: ctx.actor.userId,
            reasonCode: input.reasonCode,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
