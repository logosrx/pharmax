// UpdateProvider — edit a row in the prescriber directory.
//
// The plaintext counterpart to UpdatePatient. Same tri-state +
// change-set + locked-state-guard + predicate-CAS pattern, but with
// no encryption surface — provider data is plaintext on purpose (see
// RegisterProvider's file header for the rationale).
//
// Design choices worth reading before you change this file:
//
//   - NPI IS IMMUTABLE. The schema enforces
//     `@@unique([organizationId, npi])`, and NPI is the prescriber's
//     national identifier — it never changes for a given person.
//     Fixing a typo'd NPI is a `DeactivateProvider` + new
//     `RegisterProvider` motion, not an edit. The schema below omits
//     `npi` and uses `.strict()` so submitting it surfaces as
//     `COMMAND_INPUT_INVALID` at the Zod boundary.
//
//   - STATUS IS NOT MUTATED HERE. Activation / deactivation is its
//     own command (`DeactivateProvider`, future). UpdateProvider
//     accepts no `status` key. The motivation is the same as for
//     NPI: a status change is a different operator intent with a
//     different audit shape, different downstream effects (existing
//     prescriptions on a deactivated provider need a policy
//     decision), and a different permission grant.
//
//   - TRI-STATE INPUT.
//       * `undefined` (key absent) → leave the column alone.
//       * `null` → clear the column (optional fields only).
//       * `string` → set the column.
//     Identity fields (`firstName`, `lastName`) cannot be cleared
//     via null — a provider with no last name is structurally
//     broken. Zod's `.nullable()` is applied to the optional
//     fields only; identity stays string-only.
//
//   - LOCKED-OUT STATE. We refuse to update a row in `INACTIVE`
//     status with a typed `PROVIDER_INACTIVE` conflict. The
//     remediation is `ReactivateProvider`, not silently editing
//     the deactivated row. Editing an INACTIVE provider
//     would be either (a) confusion ("I thought this person was
//     still active") or (b) an attempt to subvert the
//     `DeactivateProvider` audit trail — both are operator errors
//     surfaced loudly.
//
//   - CAS PREDICATE. We use `updateMany` with a where clause that
//     re-checks `status: ACTIVE`. A concurrent deactivation
//     between our read and our write returns `count: 0`, which we
//     translate to a typed `PROVIDER_UPDATE_RACE_LOST` (the
//     UpdatePatient analog).
//
//   - NO-OP REJECTION. Submitting `{ providerId }` with no other
//     keys raises `PROVIDER_UPDATE_NO_CHANGES`. Same rationale as
//     UpdatePatient: a no-op edit shouldn't burn an audit row.
//
// PHI rule (same as RegisterProvider):
//   - NPI stays IN audit metadata and outbox payload as the
//     event's primary anchor (public identifier; needed for the
//     event to be meaningful).
//   - `deaNumber` plaintext is REDACTED from command_log via the
//     bus's `redactFields` and is NEVER in audit metadata or the
//     outbox payload. Presence is expressed as `hasDea: boolean`
//     in audit metadata — useful for compliance reports
//     ("how many providers carry a DEA?") without exposing the
//     credential string.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { ProviderStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

// ---------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------

const inputSchema = z
  .object({
    providerId: z.string().uuid(),

    // Identity — string-only patches. NPI is deliberately absent
    // (immutable) and the `.strict()` below rejects any caller that
    // tries to submit it.
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),

    // Optional fields — string sets, null clears, absent leaves alone.
    credential: z.string().min(1).max(40).nullable().optional(),
    deaNumber: z
      .string()
      .regex(/^[A-Z]{2}\d{7}$/, "expected 2 uppercase letters followed by 7 digits")
      .nullable()
      .optional(),
    phone: z.string().min(7).max(40).nullable().optional(),
    email: z.email().max(320).nullable().optional(),
    addressLine1: z.string().min(1).max(200).nullable().optional(),
    addressLine2: z.string().min(1).max(200).nullable().optional(),
    city: z.string().min(1).max(100).nullable().optional(),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/, "expected 2-letter state code")
      .nullable()
      .optional(),
    postalCode: z
      .string()
      .regex(/^\d{5}(-\d{4})?$/, "expected ZIP or ZIP+4")
      .nullable()
      .optional(),
  })
  .strict();

export type UpdateProviderInput = z.infer<typeof inputSchema>;

export interface UpdateProviderOutput {
  readonly providerId: string;
  /** ISO timestamp at which the update was committed. */
  readonly updatedAt: string;
  /** Sorted list of input keys whose value was SET in this update. */
  readonly updatedFields: ReadonlyArray<string>;
  /** Sorted list of optional keys that were CLEARED (set to null). */
  readonly clearedFields: ReadonlyArray<string>;
}

// Only `deaNumber` is confidential; everything else is plaintext
// (or already public, in NPI's case — which isn't in this schema).
const REDACT_FIELDS = Object.freeze(["deaNumber"] as const);

// All updatable input keys (excluding providerId). Used to walk the
// input deterministically when building the audit change-set.
const UPDATABLE_KEYS = Object.freeze([
  "firstName",
  "lastName",
  "credential",
  "deaNumber",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
] as const);

// Identity keys cannot be CLEARED. Zod enforces this at the schema
// level (no `.nullable()` on these), but we re-assert with a typed
// throw as defense-in-depth against future schema weakening.
const IDENTITY_KEYS: ReadonlySet<string> = new Set(["firstName", "lastName"]);

// ---------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------

export const UpdateProvider: Command<UpdateProviderInput, UpdateProviderOutput> = {
  name: "UpdateProvider",
  inputSchema,
  permission: PERMISSIONS.PROVIDERS_UPDATE,
  redactFields: REDACT_FIELDS,

  async handle({
    input,
    ctx,
    tx,
    commandLogId,
    clock,
  }): Promise<HandlerResult<UpdateProviderOutput>> {
    const now = clock.now();
    const tenantId = ctx.organizationId;

    // ---- Step 1 — Compute the change set. ----
    //
    // Classify each provided key as either "updated" (value) or
    // "cleared" (explicit null). Absent keys are skipped. Identity
    // keys cannot be cleared (defense-in-depth; Zod already rejects).
    const updatedFields: string[] = [];
    const clearedFields: string[] = [];
    const bag = input as unknown as Record<string, string | null | undefined>;

    for (const key of UPDATABLE_KEYS) {
      const v = bag[key];
      if (v === undefined) continue;
      if (v === null) {
        if (IDENTITY_KEYS.has(key)) {
          throw new errors.ValidationError({
            code: "PROVIDER_UPDATE_IDENTITY_CANNOT_CLEAR",
            message: `Identity field "${key}" cannot be cleared on a provider.`,
            issues: [{ path: [key], message: "null not allowed for identity field" }],
          });
        }
        clearedFields.push(key);
      } else {
        updatedFields.push(key);
      }
    }

    if (updatedFields.length === 0 && clearedFields.length === 0) {
      throw new errors.ValidationError({
        code: "PROVIDER_UPDATE_NO_CHANGES",
        message: "Update requires at least one field besides providerId.",
        issues: [{ path: [], message: "no updatable fields provided" }],
      });
    }

    // ---- Step 2 — Read the row for guard checks. ----
    //
    // Read columns we need for guards + audit metadata. `npi` rides
    // into audit/outbox as the action's anchor. `status` powers the
    // INACTIVE guard. `deaNumber` (post-update) determines `hasDea`
    // in audit metadata; we re-read it after the update to reflect
    // the new state (an update that clears DEA flips hasDea to false).
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
      // Refuse rather than silently edit. The remediation is
      // ReactivateProvider, not a back-door edit of the
      // deactivated row.
      throw new errors.ConflictError({
        code: "PROVIDER_INACTIVE",
        message:
          "Provider is INACTIVE. Reactivate the provider before editing, or register a new row.",
        metadata: { providerId: input.providerId },
      });
    }

    // ---- Step 3 — Build the column write map. ----
    //
    // Plain Record<string, unknown>: Prisma's update input is a
    // tagged union that varies column by column; the surrounding
    // `updateMany` call is the type boundary.
    const data: Record<string, unknown> = {};

    for (const key of UPDATABLE_KEYS) {
      const v = bag[key];
      if (v === undefined) continue;
      // null on optional → write SQL NULL; string → write value;
      // identity nulls are blocked above.
      data[key] = v;
    }

    // ---- Step 4 — Atomic CAS update. ----
    //
    // The where clause re-checks `status: ACTIVE`. A concurrent
    // DeactivateProvider between our read in step 2 and this write
    // returns count=0; the bus rolls back the tx.
    const result = await tx.provider.updateMany({
      where: {
        id: input.providerId,
        organizationId: tenantId,
        status: ProviderStatus.ACTIVE,
      },
      data,
    });

    if (result.count === 0) {
      throw new errors.ConflictError({
        code: "PROVIDER_UPDATE_RACE_LOST",
        message:
          "Provider state changed during update (concurrent deactivation). Refetch the provider and resubmit if needed.",
        metadata: { providerId: input.providerId },
      });
    }

    // ---- Step 5 — Audit + outbox (PHI-free). ----
    //
    // Sort the change-set lists so audit consumers and downstream
    // analytics get a stable ordering regardless of input ordering.
    updatedFields.sort();
    clearedFields.sort();

    // Compute the POST-UPDATE `hasDea` boolean. If the update set
    // deaNumber, hasDea is true. If the update cleared it, hasDea
    // is false. If the update didn't touch it, hasDea preserves the
    // pre-read value.
    const hasDea =
      input.deaNumber === null
        ? false
        : input.deaNumber !== undefined
          ? true
          : provider.deaNumber !== null;

    return {
      output: {
        providerId: input.providerId,
        updatedAt: now.toISOString(),
        updatedFields,
        clearedFields,
      },
      audit: {
        action: "provider.updated",
        resourceType: "Provider",
        resourceId: input.providerId,
        metadata: {
          // NPI stays as the action's primary anchor (same rationale
          // as RegisterProvider — public identifier, needed for the
          // event to be meaningful to SOC 2 reviewers / analytics).
          npi: provider.npi,
          updatedFields,
          clearedFields,
          hasDea,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "provider.updated.v1",
          aggregateType: "Provider",
          aggregateId: input.providerId,
          payload: {
            providerId: input.providerId,
            organizationId: tenantId,
            npi: provider.npi,
            updatedFields,
            clearedFields,
            occurredAt: now.toISOString(),
          },
        },
      ],
    };
  },
};
