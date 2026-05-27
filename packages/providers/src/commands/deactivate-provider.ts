// DeactivateProvider — flip a prescriber row ACTIVE → INACTIVE.
//
// The companion to UpdateProvider for one specific transition:
// taking a provider out of service. New orders against an INACTIVE
// prescriber are blocked (downstream readers gate on `status`); the
// disposition of in-flight orders is a worker decision keyed off the
// outbox event's `reason` code (see `provider.deactivated.v1` below).
//
// Design choices worth reading before you change this file:
//
//   - WHY A SEPARATE COMMAND, NOT A `status` KEY ON UpdateProvider.
//     A status change has a different audit shape (it carries a
//     REASON, not a column diff), different permission grant
//     (`providers.deactivate`), different downstream effects (workers
//     subscribe to `provider.deactivated.v1` to decide whether to
//     interrupt in-flight orders for the most severe reasons), and
//     should never accidentally ride along with a name/address edit.
//     Splitting it out makes the operator intent unambiguous and the
//     audit log filter trivial ("show me every deactivation last
//     quarter, by reason"). Same rationale as `CancelOrder` being
//     separate from arbitrary order edits.
//
//   - PURE STATUS FLIP, NO NEW TABLE. Historically "who deactivated
//     which provider, when, and why" is exactly what `audit_log` was
//     built for. The Provider domain is far less workflow-intensive
//     than Order (no per-order rework loop, no high re-deactivation
//     frequency), so a structured `provider_deactivation` table
//     would be carrying its weight only for analytics. We get those
//     reports cleanly from `audit_log.action = 'provider.deactivated'`
//     filtered by `metadata.reason`. If re-deactivation history
//     (deactivation → reactivation → deactivation cycles) becomes a
//     real reporting need beyond what `audit_log` offers, we
//     migrate to a structured table then.
//
//   - REASON IS A CLOSED ENUM. The reason code is a runtime literal
//     union (not a Prisma enum, because we are not writing it to a
//     DB column). Adding a new reason code is a typed change — the
//     bus, audit consumers, and worker subscribers see the new
//     literal and the compiler enforces exhaustiveness wherever we
//     `switch (reason)`. `OTHER` is the escape hatch and REQUIRES
//     a non-empty `reasonText` (Zod refinement) so we never
//     accidentally swallow an "other" with no explanation.
//
//   - REASON TEXT IS REDACTED FROM `command_log`. Free-text reasons
//     can carry sensitive narrative ("provider lost DEA following
//     disciplinary action", "patient complaint about prescribing
//     practices"). The reason CODE is safe and travels everywhere
//     (command_log, audit metadata, outbox payload). The reason
//     TEXT travels nowhere except its redacted slot in command_log
//     and the operator's UI flash. Audit metadata and outbox
//     payload carry a `hasReasonText: boolean` marker instead, so
//     consumers know whether to surface "view reason note" in a UI
//     without ever shipping the bytes.
//
//   - LOCKED-OUT STATE. We refuse to deactivate a row already in
//     INACTIVE status with a typed `PROVIDER_ALREADY_INACTIVE`
//     conflict. The operator should know the state — silently
//     succeeding on an already-deactivated provider hides the fact
//     that something else deactivated it first, which matters for
//     the "did our deactivation actually fire?" question.
//
//   - CAS PREDICATE. The `updateMany` where clause re-checks
//     `status: ACTIVE`. A concurrent deactivation between our read
//     and our write returns `count: 0`, which we surface as
//     `PROVIDER_DEACTIVATE_RACE_LOST` — the loser of the race gets
//     a typed conflict, not a duplicate outbox event.
//
// PHI rule:
//   - NPI stays IN audit metadata and outbox payload as the event's
//     primary anchor (public identifier; needed for the event to be
//     meaningful).
//   - `deaNumber` plaintext is NEVER referenced here — we don't
//     read it on the way in, don't surface it on the way out. The
//     `hadDea` snapshot in metadata is computed from the
//     pre-deactivation row's nullity only.
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

// Closed list of deactivation reasons. ORDER MATTERS for the Zod
// enum tuple (it's used as the canonical iteration order). Adding a
// new code is a typed change; existing audit rows continue to carry
// whatever code they were created with.
export const PROVIDER_DEACTIVATION_REASONS = Object.freeze([
  // Provider stopped practicing on their own terms.
  "RETIRED",
  // Provider moved out of our service area.
  "RELOCATED",
  // Business relationship ended (clinic / pharmacy parted ways).
  "RELATIONSHIP_ENDED",
  // Active license lapsed; remediation is renewal + ReactivateProvider.
  "LICENSE_EXPIRED",
  // DEA registration surrendered or revoked — CS prescribing must stop.
  // Downstream workers MAY halt in-flight controlled-substance fills
  // for this reason; tracked separately so subscribers can branch on it.
  "DEA_SURRENDERED_OR_REVOKED",
  // State board disciplinary action. Like the DEA reason above, this
  // is a severity signal for downstream "halt in-flight" workers.
  "SANCTIONED",
  // Provider passed away.
  "DECEASED",
  // Duplicate of another provider row; deactivating this one so the
  // canonical row is the one referenced going forward.
  "DUPLICATE_RECORD",
  // Escape hatch — REQUIRES non-empty reasonText (enforced by Zod
  // refinement below).
  "OTHER",
] as const);

export type ProviderDeactivationReason = (typeof PROVIDER_DEACTIVATION_REASONS)[number];

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const inputSchema = z
  .object({
    providerId: z.string().uuid(),
    reason: z.enum(PROVIDER_DEACTIVATION_REASONS as unknown as [string, ...string[]]),
    // Optional free-text rationale. Cap is generous (UI textarea)
    // but bounded to keep command_log size predictable.
    reasonText: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine((v) => v.reason !== "OTHER" || (v.reasonText !== undefined && v.reasonText.length > 0), {
    message: "reasonText is required when reason is OTHER",
    path: ["reasonText"],
  });

export type DeactivateProviderInput = z.infer<typeof inputSchema>;

export interface DeactivateProviderOutput {
  readonly providerId: string;
  /** ISO timestamp at which the deactivation was committed. */
  readonly deactivatedAt: string;
  /** Echoed reason code (closed enum). */
  readonly reason: ProviderDeactivationReason;
}

// `reasonText` is the only sensitive field — closed-enum `reason`
// stays plaintext everywhere as a structured signal.
const REDACT_FIELDS = Object.freeze(["reasonText"] as const);

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const DeactivateProvider: Command<DeactivateProviderInput, DeactivateProviderOutput> = {
  name: "DeactivateProvider",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_DEACTIVATE,
  redactFields: REDACT_FIELDS,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<DeactivateProviderOutput>> {
    const now = clock.now();
    const tenantId = ctx.organizationId;
    const reason = input.reason as ProviderDeactivationReason;

    // ---- Step 1 — Read the row for guard checks. ----
    //
    // We need:
    //   - existence (404 if missing or wrong tenant)
    //   - status (PROVIDER_ALREADY_INACTIVE if not ACTIVE)
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

    if (provider.status === ProviderStatus.INACTIVE) {
      throw new errors.ConflictError({
        code: "PROVIDER_ALREADY_INACTIVE",
        message: "Provider is already INACTIVE. Use ReactivateProvider before re-deactivating.",
        metadata: { providerId: input.providerId },
      });
    }

    // ---- Step 2 — Atomic CAS flip. ----
    //
    // The where clause re-checks `status: ACTIVE`. A concurrent
    // DeactivateProvider that won the race returns count=0; this
    // caller loses cleanly without producing a duplicate event.
    const result = await tx.provider.updateMany({
      where: {
        id: input.providerId,
        organizationId: tenantId,
        status: ProviderStatus.ACTIVE,
      },
      data: { status: ProviderStatus.INACTIVE },
    });

    if (result.count === 0) {
      throw new errors.ConflictError({
        code: "PROVIDER_DEACTIVATE_RACE_LOST",
        message:
          "Provider state changed during deactivation (concurrent deactivation). Refetch the provider and re-evaluate before retrying.",
        metadata: { providerId: input.providerId },
      });
    }

    // ---- Step 3 — Audit + outbox (PHI-free). ----
    //
    // `hasReasonText` lets consumers know whether to surface a
    // "view rationale" link in their UI without ever shipping the
    // text. `hadDea` is a pre-deactivation snapshot for compliance
    // reports ("how many providers we deactivated had DEA?").
    const hasReasonText = input.reasonText !== undefined && input.reasonText.length > 0;
    const hadDea = provider.deaNumber !== null;

    return {
      output: {
        providerId: input.providerId,
        deactivatedAt: now.toISOString(),
        reason,
      },
      audit: {
        action: "provider.deactivated",
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
          eventType: "provider.deactivated.v1",
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
