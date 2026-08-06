// PublishCompoundFormula — promote a DRAFT Master Formulation Record
// version to ACTIVE (ADR-0035).
//
// Publishing is the immutability boundary: from here on the version's
// recipe content is frozen (there is no update command for non-DRAFT
// rows, and slice-2 compounding records pin the version they prepared
// from). Publishing version N retires the previously ACTIVE version
// of the same code IN THE SAME TRANSACTION, so at any instant an org
// has at most one ACTIVE version per code — the one preparers see.
//
// The supersede is recorded three ways: `retiredAt` on the old row
// (with NO retiredReason — reason codes are for out-of-band
// RetireCompoundFormula pulls), `supersededFormulaId` in the published
// event, and the audit metadata.
//
// Concurrency: both the DRAFT row and the predecessor are updated
// with status-guarded writes inside the command transaction; a racing
// publish of the same draft loses on the status recheck.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { CompoundFormulaStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

import {
  COMPOUND_FORMULA_INVALID_STATE,
  COMPOUND_FORMULA_NOT_FOUND,
  COMPOUND_FORMULA_PRODUCT_ALREADY_CLAIMED,
} from "../shared.js";

const inputSchema = z
  .object({
    formulaId: z.uuid(),
  })
  .strict();

export type PublishCompoundFormulaInput = z.infer<typeof inputSchema>;

export interface PublishCompoundFormulaOutput {
  readonly formulaId: string;
  readonly code: string;
  readonly version: number;
  readonly supersededFormulaId: string | null;
}

export const PublishCompoundFormula: Command<
  PublishCompoundFormulaInput,
  PublishCompoundFormulaOutput
> = {
  name: "PublishCompoundFormula",
  inputSchema,
  permission: PERMISSIONS.COMPOUNDING_FORMULA_MANAGE,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<PublishCompoundFormulaOutput>> {
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
    if (formula.status !== CompoundFormulaStatus.DRAFT) {
      throw new errors.ConflictError({
        code: COMPOUND_FORMULA_INVALID_STATE,
        message: `Formula is ${formula.status}; only DRAFT versions can be published.`,
        metadata: { formulaId: formula.id, status: formula.status },
      });
    }

    const now = clock.now();

    // Retire the predecessor (at most one, by the invariant this very
    // command maintains). `updateMany` with the status in the WHERE is
    // the concurrency guard: a racing publish that already retired it
    // matches zero rows here, and its own draft-status recheck decides
    // the winner.
    const predecessor = await tx.compoundFormula.findFirst({
      where: {
        organizationId: ctx.organizationId,
        code: formula.code,
        status: CompoundFormulaStatus.ACTIVE,
      },
      select: { id: true, version: true },
    });
    if (predecessor !== null) {
      await tx.compoundFormula.updateMany({
        where: { id: predecessor.id, status: CompoundFormulaStatus.ACTIVE },
        data: {
          status: CompoundFormulaStatus.RETIRED,
          retiredAt: now,
        },
      });
    }

    try {
      await tx.compoundFormula.update({
        where: { id: formula.id },
        data: {
          status: CompoundFormulaStatus.ACTIVE,
          publishedAt: now,
        },
        select: { id: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // The partial unique "one ACTIVE formula per (org,
        // compoundProductId)": an ACTIVE formula of a DIFFERENT code
        // already claims this draft's product. Same-code succession
        // never lands here — the predecessor was retired above in
        // this transaction. Two recipes both claiming to be "the"
        // recipe for one dispensable product would make the PV1
        // screen's answer ambiguous, so the second publisher gets a
        // typed conflict and a decision to make, not a race to win.
        throw new errors.ConflictError({
          code: COMPOUND_FORMULA_PRODUCT_ALREADY_CLAIMED,
          message:
            "Another ACTIVE formula already claims this draft's compound product. " +
            "Retire it (or publish a new version of it without the product link) before publishing this one.",
          metadata: { formulaId: formula.id, code: formula.code },
        });
      }
      throw err;
    }

    return {
      output: {
        formulaId: formula.id,
        code: formula.code,
        version: formula.version,
        supersededFormulaId: predecessor?.id ?? null,
      },
      audit: {
        action: "compounding.formula.published",
        resourceType: "CompoundFormula",
        resourceId: formula.id,
        metadata: {
          code: formula.code,
          version: formula.version,
          supersededFormulaId: predecessor?.id ?? null,
          supersededVersion: predecessor?.version ?? null,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "compounding.formula.published.v1",
          aggregateType: "CompoundFormula",
          aggregateId: formula.id,
          payload: {
            formulaId: formula.id,
            organizationId: ctx.organizationId,
            code: formula.code,
            version: formula.version,
            publishedByUserId: ctx.actor.userId,
            supersededFormulaId: predecessor?.id ?? null,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
