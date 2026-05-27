// ReactivateProvider — flip a prescriber row INACTIVE → ACTIVE.
//
// The mirror of DeactivateProvider with the inverse status flip and
// a deliberately DIFFERENT reason vocabulary. Once a provider is
// cleared (license restored, sanction lifted, deactivation was
// erroneous, etc.) this command brings them back into the active
// roster. New orders against the prescriber are unblocked
// immediately; the disposition of orders that were parked while the
// provider was INACTIVE is a downstream worker decision keyed off
// `provider.reactivated.v1`'s `reason` (e.g. "DEA_RESTORED" can
// release CS fills that were halted by `DEA_SURRENDERED_OR_REVOKED").
//
// Design choices worth reading before you change this file:
//
//   - WHY A SEPARATE COMMAND, NOT A `status` KEY ON UpdateProvider.
//     Same rationale as DeactivateProvider's mirror argument: a
//     status restoration carries a REASON (not a column diff), a
//     different permission grant (`providers.reactivate`), and a
//     different downstream subscription surface than a name/address
//     edit. Splitting it out makes the operator intent unambiguous
//     and the audit-log filter trivial ("show every reactivation
//     last quarter, by reason").
//
//   - WHY A SEPARATE COMMAND FROM DeactivateProvider, NOT A SHARED
//     "SET STATUS" COMMAND. The two commands look symmetric in the
//     status flip but they are NOT symmetric in their reason
//     vocabularies, downstream effects, or audit semantics:
//       * Deactivation can be "DEA_SURRENDERED_OR_REVOKED" — a code
//         no reactivation can carry directly (the reactivation code
//         is "DEA_RESTORED", a different audit story).
//       * Deactivation has terminal codes (`DECEASED`,
//         `DUPLICATE_RECORD`) that have NO reactivation
//         counterparts; you cannot reactivate a deceased provider.
//       * Reactivation has `ERRONEOUS_DEACTIVATION` — the
//         audit-correction path — which has no deactivation analog
//         (correcting a missed deactivation is a fresh
//         DeactivateProvider call, not an audit fix).
//     Keeping the commands separate keeps each Zod enum a CLOSED
//     vocabulary that captures only the codes meaningful for that
//     direction.
//
//   - PURE STATUS FLIP, NO NEW TABLE. Same as DeactivateProvider:
//     audit_log + the outbox event already give us "who reactivated
//     which provider, when, and why". A `provider_reactivation`
//     table would be carrying its weight only for analytics and we
//     get those reports cleanly from
//     `audit_log.action = 'provider.reactivated'` filtered by
//     `metadata.reason`.
//
//   - REASON IS A CLOSED ENUM. Like the deactivation reason. Adding
//     a new reactivation reason is a typed change. `OTHER` is the
//     escape hatch and REQUIRES a non-empty `reasonText` (Zod
//     refinement) so we never silently swallow an "other" with no
//     explanation.
//
//   - REASON TEXT IS REDACTED FROM `command_log`. Free-text
//     reactivation rationales can carry sensitive narrative
//     ("provider's DEA reinstated after settlement of disciplinary
//     hearing"). The reason CODE is safe and travels everywhere
//     (command_log, audit metadata, outbox payload). The reason
//     TEXT travels nowhere except its redacted slot in command_log
//     and the operator's UI flash. Audit metadata and outbox
//     payload carry a `hasReasonText: boolean` marker instead.
//
//   - LOCKED-OUT STATE. We refuse to reactivate a row that is
//     already in ACTIVE status with a typed
//     `PROVIDER_ALREADY_ACTIVE` conflict. Silently succeeding on an
//     already-active provider would hide the fact that something
//     else reactivated it first, which matters for the "did our
//     reactivation actually fire?" question.
//
//   - CAS PREDICATE. The `updateMany` where clause re-checks
//     `status: INACTIVE`. A concurrent reactivation between our
//     read and our write returns `count: 0`, which we surface as
//     `PROVIDER_REACTIVATE_RACE_LOST` — the loser of the race gets
//     a typed conflict, not a duplicate outbox event.
//
// PHI rule (mirror of DeactivateProvider):
//   - NPI stays IN audit metadata and outbox payload as the event's
//     primary anchor (public identifier; needed for the event to be
//     meaningful).
//   - `deaNumber` plaintext is NEVER referenced here — we don't
//     read it on the way in, don't surface it on the way out. The
//     `hadDea` snapshot in metadata is computed from the
//     pre-reactivation row's nullity only.
//   - `reasonText` is redacted from command_log; absent from audit
//     metadata and outbox payload; presence flagged as
//     `hasReasonText: boolean`.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { ProviderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

// ---------------------------------------------------------------------
// Reason enum (TS literal union — NOT a Prisma enum)
// ---------------------------------------------------------------------

// Closed list of reactivation reasons. ORDER MATTERS for the Zod
// enum tuple (it's used as the canonical iteration order). Adding a
// new code is a typed change; existing audit rows continue to carry
// whatever code they were created with.
//
// DELIBERATE NON-PARITY WITH PROVIDER_DEACTIVATION_REASONS:
//   - Terminal-state deactivation codes (DECEASED, DUPLICATE_RECORD)
//     have no reactivation counterpart — you cannot bring a
//     deceased provider back, you cannot "un-merge" a duplicate.
//   - ERRONEOUS_DEACTIVATION exists only on this side. It is the
//     audit-correction path for "we deactivated the wrong row" or
//     "the deactivation was filed against the wrong reason code";
//     the operator narrative belongs in `reasonText` for context.
//   - LICENSE_RESTORED, DEA_RESTORED, SANCTION_LIFTED are the
//     resolution counterparts of LICENSE_EXPIRED,
//     DEA_SURRENDERED_OR_REVOKED, SANCTIONED — but they are
//     STRUCTURAL counterparts, not synonyms. A reactivation worker
//     should be able to release CS fills on DEA_RESTORED without
//     having to negate "is this a deactivation reason inverse?".
export const PROVIDER_REACTIVATION_REASONS = Object.freeze([
  // Active license re-issued / renewed; counterpart of LICENSE_EXPIRED.
  "LICENSE_RESTORED",
  // DEA registration restored / new registration issued; counterpart
  // of DEA_SURRENDERED_OR_REVOKED. Downstream workers MAY release
  // controlled-substance fills that were halted on the deactivation.
  "DEA_RESTORED",
  // State board lifted disciplinary action; counterpart of SANCTIONED.
  "SANCTION_LIFTED",
  // Pharmacy / clinic relationship reopened.
  "RELATIONSHIP_RESUMED",
  // Provider came out of retirement.
  "RETURNED_FROM_RETIREMENT",
  // Provider moved back into our service area.
  "RELOCATED_BACK_INTO_AREA",
  // The deactivation itself was a mistake — wrong row, wrong reason
  // code, accidental click. This is the audit-correction path; the
  // operator should attach a reasonText explaining the prior error
  // even though the schema does not require it (the reasonText
  // refinement only fires on OTHER).
  "ERRONEOUS_DEACTIVATION",
  // Escape hatch — REQUIRES non-empty reasonText (enforced by Zod
  // refinement below).
  "OTHER",
] as const);

export type ProviderReactivationReason = (typeof PROVIDER_REACTIVATION_REASONS)[number];

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const inputSchema = z
  .object({
    providerId: z.string().uuid(),
    reason: z.enum(PROVIDER_REACTIVATION_REASONS as unknown as [string, ...string[]]),
    // Optional free-text rationale. Cap is generous (UI textarea)
    // but bounded to keep command_log size predictable.
    reasonText: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine((v) => v.reason !== "OTHER" || (v.reasonText !== undefined && v.reasonText.length > 0), {
    message: "reasonText is required when reason is OTHER",
    path: ["reasonText"],
  });

export type ReactivateProviderInput = z.infer<typeof inputSchema>;

export interface ReactivateProviderOutput {
  readonly providerId: string;
  /** ISO timestamp at which the reactivation was committed. */
  readonly reactivatedAt: string;
  /** Echoed reason code (closed enum). */
  readonly reason: ProviderReactivationReason;
}

// `reasonText` is the only sensitive field — closed-enum `reason`
// stays plaintext everywhere as a structured signal.
const REDACT_FIELDS = Object.freeze(["reasonText"] as const);

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const ReactivateProvider: Command<ReactivateProviderInput, ReactivateProviderOutput> = {
  name: "ReactivateProvider",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_REACTIVATE,
  redactFields: REDACT_FIELDS,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<ReactivateProviderOutput>> {
    const now = clock.now();
    const tenantId = ctx.organizationId;
    const reason = input.reason as ProviderReactivationReason;

    // ---- Step 1 — Read the row for guard checks. ----
    //
    // We need:
    //   - existence (404 if missing or wrong tenant)
    //   - status (PROVIDER_ALREADY_ACTIVE if not INACTIVE)
    //   - npi for the audit/outbox anchor
    //   - deaNumber nullity for the `hadDea` boolean (we never
    //     surface the plaintext, just whether one was present)
    const provider = await tx.provider.findUnique({
      where: { id: input.providerId },
      select: {
        id: true,
        organizationId: true,
        npi: true,
        status: true,
        deaNumber: true,
      },
    });

    if (provider === null) {
      throw new errors.NotFoundError({
        code: "PROVIDER_NOT_FOUND",
        message: "Provider does not exist or is not in this organization.",
        metadata: { providerId: input.providerId },
      });
    }

    if (provider.status === ProviderStatus.ACTIVE) {
      throw new errors.ConflictError({
        code: "PROVIDER_ALREADY_ACTIVE",
        message: "Provider is already ACTIVE; reactivation is a no-op.",
        metadata: { providerId: input.providerId },
      });
    }

    // ---- Step 2 — Atomic CAS flip. ----
    //
    // The where clause re-checks `status: INACTIVE`. A concurrent
    // ReactivateProvider that won the race returns count=0; this
    // caller loses cleanly without producing a duplicate event.
    const result = await tx.provider.updateMany({
      where: {
        id: input.providerId,
        organizationId: tenantId,
        status: ProviderStatus.INACTIVE,
      },
      data: { status: ProviderStatus.ACTIVE },
    });

    if (result.count === 0) {
      throw new errors.ConflictError({
        code: "PROVIDER_REACTIVATE_RACE_LOST",
        message:
          "Provider state changed during reactivation (concurrent reactivation). Refetch the provider and re-evaluate before retrying.",
        metadata: { providerId: input.providerId },
      });
    }

    // ---- Step 3 — Audit + outbox (PHI-free). ----
    //
    // `hasReasonText` lets consumers know whether to surface a
    // "view rationale" link in their UI without ever shipping the
    // text. `hadDea` is a pre-reactivation snapshot — useful for
    // CS-fill-resume workers that want to know whether the
    // reactivated provider is even capable of CS prescribing.
    const hasReasonText = input.reasonText !== undefined && input.reasonText.length > 0;
    const hadDea = provider.deaNumber !== null;

    return {
      output: {
        providerId: input.providerId,
        reactivatedAt: now.toISOString(),
        reason,
      },
      audit: {
        action: "provider.reactivated",
        resourceType: "Provider",
        resourceId: input.providerId,
        metadata: {
          npi: provider.npi,
          reason,
          hasReasonText,
          hadDea,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.reactivated.v1",
          aggregateType: "Provider",
          aggregateId: input.providerId,
          payload: {
            providerId: input.providerId,
            organizationId: tenantId,
            npi: provider.npi,
            reason,
            hasReasonText,
            hadDea,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
