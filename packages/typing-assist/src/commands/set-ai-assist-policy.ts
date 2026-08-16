// SetAiAssistPolicy — author or revise the org-level AI typing-assist
// policy (typing-assist phase 1).
//
// One row per organization, upsert semantics, version bump on every
// revision. The policy is the tenant's master switch for model-backed
// typing suggestions: an org that never dispatches this command has
// no row, and every consumer treats "no row" as OFF — the model never
// runs against that org's data. Turning it on is therefore always an
// explicit, audited, OrgAdmin-gated act.
//
// The version bump matters for the same reason it does on workflow
// policies: a later-phase suggestion batch records the policy version
// that governed it, so "was the model allowed to run on this order?"
// is answered against the revision in force at the time, not against
// whatever the row says when the auditor asks.
//
// Gated on `ai.assist_policy.manage` (OrgAdmin only by default) —
// deliberately separate from `inventory.products.manage`: bounding
// one product is a catalog judgement, enabling a model org-wide is a
// governance decision.
//
// Non-order aggregate: plain `Command` shape. Org configuration only
// — no PHI anywhere in this command.

import { randomUUID } from "node:crypto";

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

// ---------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------

export const AI_ASSIST_POLICY_CONFLICT = "AI_ASSIST_POLICY_CONFLICT";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const inputSchema = z
  .object({
    typingAssistEnabled: z.boolean(),
    /** Minimum model confidence (0–100) for a suggestion to be shown
     *  to a technician. */
    minConfidencePercent: z.int().min(0).max(100),
    allowControlledSubstanceSuggestions: z.boolean(),
  })
  .strict();

export type SetAiAssistPolicyInput = z.infer<typeof inputSchema>;

export interface SetAiAssistPolicyOutput {
  readonly policyId: string;
  readonly version: number;
  readonly created: boolean;
  readonly typingAssistEnabled: boolean;
}

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const SetAiAssistPolicy: Command<SetAiAssistPolicyInput, SetAiAssistPolicyOutput> = {
  name: "SetAiAssistPolicy",
  inputSchema,
  permission: PERMISSIONS.AI_ASSIST_POLICY_MANAGE,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<SetAiAssistPolicyOutput>> {
    const now = clock.now();

    const existing = await tx.aiAssistPolicy.findFirst({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        version: true,
        typingAssistEnabled: true,
        minConfidencePercent: true,
        allowControlledSubstanceSuggestions: true,
      },
    });

    let policyId: string;
    let version: number;
    let created: boolean;

    if (existing === null) {
      policyId = randomUUID();
      version = 1;
      created = true;
      try {
        await tx.aiAssistPolicy.create({
          data: {
            id: policyId,
            organizationId: ctx.organizationId,
            typingAssistEnabled: input.typingAssistEnabled,
            minConfidencePercent: input.minConfidencePercent,
            allowControlledSubstanceSuggestions: input.allowControlledSubstanceSuggestions,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new errors.ConflictError({
            code: AI_ASSIST_POLICY_CONFLICT,
            cause: err,
            message: "A concurrent revision created this organization's AI policy; retry.",
            metadata: {},
          });
        }
        throw err;
      }
    } else {
      policyId = existing.id;
      version = existing.version + 1;
      created = false;
      // CAS on version: concurrent revisions serialize instead of both
      // claiming the same version number.
      const updated = await tx.aiAssistPolicy.updateMany({
        where: { id: existing.id, version: existing.version },
        data: {
          typingAssistEnabled: input.typingAssistEnabled,
          minConfidencePercent: input.minConfidencePercent,
          allowControlledSubstanceSuggestions: input.allowControlledSubstanceSuggestions,
          version,
        },
      });
      if (updated.count !== 1) {
        throw new errors.ConflictError({
          code: AI_ASSIST_POLICY_CONFLICT,
          message: "The AI policy was revised concurrently; reload and retry.",
          metadata: { expectedVersion: existing.version },
        });
      }
    }

    const auditBefore =
      existing === null
        ? null
        : {
            typingAssistEnabled: existing.typingAssistEnabled,
            minConfidencePercent: existing.minConfidencePercent,
            allowControlledSubstanceSuggestions: existing.allowControlledSubstanceSuggestions,
          };

    return {
      output: {
        policyId,
        version,
        created,
        typingAssistEnabled: input.typingAssistEnabled,
      },
      audit: {
        action: created ? "ai.assist_policy.created" : "ai.assist_policy.revised",
        resourceType: "AiAssistPolicy",
        resourceId: policyId,
        metadata: {
          policyId,
          version,
          before: auditBefore,
          after: {
            typingAssistEnabled: input.typingAssistEnabled,
            minConfidencePercent: input.minConfidencePercent,
            allowControlledSubstanceSuggestions: input.allowControlledSubstanceSuggestions,
          },
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "ai.assist_policy.set.v1",
          aggregateType: "AiAssistPolicy",
          aggregateId: policyId,
          payload: {
            policyId,
            organizationId: ctx.organizationId,
            version,
            created,
            typingAssistEnabled: input.typingAssistEnabled,
            minConfidencePercent: input.minConfidencePercent,
            allowControlledSubstanceSuggestions: input.allowControlledSubstanceSuggestions,
            setByUserId: ctx.actor.userId,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
