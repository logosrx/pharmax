// Break-glass — time-limited emergency grants.
//
// Background:
//   Pharmacies sometimes need an actor to perform an action they
//   don't normally have permission for — a pharmacist-in-charge
//   covering a shift, an admin recovering a stuck order, etc.
//   The EONPRO answer is a free-form `emergency: true` flag on an
//   audit row, which is unauditable in practice and doesn't expire.
//
//   Our answer:
//     1. EVERY break-glass grant is time-limited (default 1h,
//        absolute cap 4h, configurable per rule but not per call).
//     2. EVERY break-glass grant writes a `BREAK_GLASS_GRANTED`
//        audit event with a non-empty reason code.
//     3. EVERY break-glass grant queues an explicit revoke event
//        for the expiration time. (Revoke also runs if an admin
//        manually revokes earlier.)
//     4. A nightly job emails the day's break-glass log to
//        `security@`. Tests can swap the email adapter for a fake.
//
// Scope:
//   Break-glass is granted to a specific (actor, permission) pair
//   for the current organization. Cross-org break-glass is not a
//   thing — that would be a separate `withSystemContext` operation.
//
// Caller contract:
//   This module defines the INTERFACE and policy validation. The
//   actual persistence (override row + audit chain + outbox event)
//   lives in `@pharmax/database` repositories that will be added
//   when the override schema lands in Phase 2. We expose
//   `BreakGlassWriter` as the seam so callers can wire a real
//   writer at boot and a fake writer in tests today.

import { errors } from "@pharmax/platform-core";

import type { PermissionCode } from "./permissions.js";

/** Absolute maximum break-glass duration. Compliance-driven, do not raise without security review. */
export const BREAK_GLASS_MAX_MINUTES = 240;

/** Default break-glass duration when the caller does not specify one. */
export const BREAK_GLASS_DEFAULT_MINUTES = 60;

/**
 * Stable reason-code vocabulary. Free-form reasons would be silently
 * mis-classified in the security dashboard. Adding a code is a SOC 2
 * audit event; mapping to "other" with a description is the escape
 * hatch.
 */
export const BREAK_GLASS_REASONS = Object.freeze({
  PIC_COVERAGE: "pic.coverage",
  STUCK_ORDER_RECOVERY: "stuck-order.recovery",
  AFTER_HOURS_EMERGENCY: "after-hours.emergency",
  AUDIT_REMEDIATION: "audit.remediation",
  OTHER: "other",
} as const);

export type BreakGlassReason = (typeof BREAK_GLASS_REASONS)[keyof typeof BREAK_GLASS_REASONS];

const ALL_BREAK_GLASS_REASONS = new Set<string>(Object.values(BREAK_GLASS_REASONS));

export interface BreakGlassGrant {
  /** ULID of the override row created in the database. */
  readonly id: string;
  readonly organizationId: string;
  readonly granteeUserId: string;
  readonly grantedByUserId: string;
  readonly permission: PermissionCode;
  readonly reason: BreakGlassReason;
  /** Free-form note. PHI-safe (no patient names — enforced by Pino redaction). */
  readonly note?: string;
  readonly expiresAt: Date;
}

/**
 * The seam between this module and the database. A production writer
 * (a) inserts an `override(granted=true, expires_at=...)` row,
 * (b) writes a `BREAK_GLASS_GRANTED` audit chain entry,
 * (c) writes an `event_outbox` row that the worker drains to schedule
 *     the auto-revoke job at `expiresAt`.
 *
 * All three writes happen in ONE transaction. The writer also emits
 * the same triple on revoke.
 */
export interface BreakGlassWriter {
  /** Persists the grant and queues the auto-revoke. */
  recordGrant(grant: BreakGlassGrant): Promise<void>;
  /**
   * Persists a revocation. Called both by the auto-revoke worker (at
   * `expiresAt`) and by manual admin action.
   */
  recordRevocation(input: {
    readonly grantId: string;
    readonly revokedByUserId: string;
    /** Stable reason code. "expired" for auto-revoke; admin-supplied otherwise. */
    readonly revocationReason: string;
    readonly note?: string;
  }): Promise<void>;
}

export const BREAK_GLASS_VALIDATION = "BREAK_GLASS_VALIDATION" as const;

/**
 * Pure policy validation. Returns the grant DTO ready to hand to the
 * writer, or throws `ValidationError(BREAK_GLASS_VALIDATION)` on
 * policy failure. This function does NOT itself write — the caller
 * (or the command handler) does, inside the command transaction.
 *
 * Pure-policy split lets tests cover every branch without a fake
 * writer, and lets us reuse the validation from the admin UI's
 * "preview" mode.
 */
export function buildBreakGlassGrant(input: {
  readonly id: string;
  readonly organizationId: string;
  readonly granteeUserId: string;
  readonly grantedByUserId: string;
  readonly permission: PermissionCode;
  readonly reason: BreakGlassReason;
  readonly durationMinutes?: number;
  readonly note?: string;
  readonly now: Date;
}): BreakGlassGrant {
  const duration = input.durationMinutes ?? BREAK_GLASS_DEFAULT_MINUTES;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new errors.ValidationError({
      code: BREAK_GLASS_VALIDATION,
      message: "Break-glass duration must be a positive number of minutes.",
      issues: [{ path: ["durationMinutes"], message: "must be > 0" }],
    });
  }
  if (duration > BREAK_GLASS_MAX_MINUTES) {
    throw new errors.ValidationError({
      code: BREAK_GLASS_VALIDATION,
      message: `Break-glass duration ${duration}m exceeds maximum ${BREAK_GLASS_MAX_MINUTES}m.`,
      issues: [
        {
          path: ["durationMinutes"],
          message: `must be ≤ ${BREAK_GLASS_MAX_MINUTES}`,
        },
      ],
    });
  }
  if (!ALL_BREAK_GLASS_REASONS.has(input.reason)) {
    throw new errors.ValidationError({
      code: BREAK_GLASS_VALIDATION,
      message: `Unknown break-glass reason code "${input.reason}".`,
      issues: [{ path: ["reason"], message: "must be a registered code" }],
    });
  }
  if (input.granteeUserId === input.grantedByUserId) {
    // No self-grants. An admin cannot break-glass themselves —
    // they would need a second admin to grant it. Mirrors the
    // four-eyes principle SoD enforces on workflow.
    throw new errors.ValidationError({
      code: BREAK_GLASS_VALIDATION,
      message: "Break-glass cannot be self-granted; a second administrator must approve.",
      issues: [{ path: ["granteeUserId"], message: "must differ from grantedByUserId" }],
    });
  }

  return {
    id: input.id,
    organizationId: input.organizationId,
    granteeUserId: input.granteeUserId,
    grantedByUserId: input.grantedByUserId,
    permission: input.permission,
    reason: input.reason,
    ...(input.note === undefined ? {} : { note: input.note }),
    expiresAt: new Date(input.now.getTime() + duration * 60_000),
  };
}

/**
 * Full happy-path helper: validate, then write. Wraps
 * `buildBreakGlassGrant` + `writer.recordGrant`. Most call sites use
 * this; the admin UI preview mode uses `buildBreakGlassGrant` alone.
 */
export async function grantBreakGlass(
  writer: BreakGlassWriter,
  input: Parameters<typeof buildBreakGlassGrant>[0]
): Promise<BreakGlassGrant> {
  const grant = buildBreakGlassGrant(input);
  await writer.recordGrant(grant);
  return grant;
}
