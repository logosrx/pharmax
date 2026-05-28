// NPI Registry sync — pure diff engine.
//
// FIRST SLICE of the `SyncFromNpiRegistry` worker (the only
// remaining provider-domain command). The engine is the
// "what-should-the-worker-do" computation in isolation from IO —
// given a local Provider row and a CMS NPPES snapshot of the same
// NPI, return a discriminated `SyncAction` describing the
// recommended next step (no-op, deactivate, update, flag for
// human review, or no record at CMS).
//
// Why slice 1 of N is the pure function:
//   - Defines vocabulary (`SyncAction` discriminants, the
//     `LocalProviderSnapshot` and `CmsNpiSnapshot` shapes) that
//     subsequent slices — HTTP client (slice 2), schema (slice 3),
//     worker wiring (slice 4) — all consume.
//   - Zero IO. Exhaustively testable as a unit. No Prisma fakes,
//     no HTTP fixtures, no clock.
//   - Reversible. If the vocabulary is wrong, edit one file. If we
//     wired the worker first and discovered the vocabulary needed
//     to change, we'd have multiple call sites to rewrite.
//
// What the engine deliberately does NOT do:
//   - It does NOT auto-reactivate. A `REACTIVATION_CANDIDATE` is
//     always handed off to a human via the operator review queue
//     (slice 6). The legitimacy of reactivation depends on the
//     ORIGINAL deactivation reason (which lives in audit_log, not
//     on the row) plus current circumstances that CMS does NOT
//     reflect. Examples:
//       * Deactivated for SANCTIONED. CMS shows the NPI is active.
//         That does NOT mean the state-board disciplinary action
//         was lifted; it means CMS' enrollment is active. We do
//         not infer sanction status from NPI status.
//       * Deactivated for DECEASED. CMS still shows the NPI as
//         active. CMS rarely deactivates immediately on death.
//         This is almost certainly an operator error in our
//         system, not a resurrection.
//       * Deactivated for DUPLICATE_RECORD. Auto-reactivating
//         would re-create the duplicate.
//       * Deactivated for ERRONEOUS_DEACTIVATION. The audit log
//         already records that we acknowledged the error; this is
//         the only case where a "CMS active again" signal aligns
//         with a legitimate next step — but the operator should
//         still confirm via `ReactivateProvider` so the human
//         decision is on the chain.
//     The engine emits a candidate; an operator confirms.
//
//   - It does NOT default to `DEA_SURRENDERED_OR_REVOKED` when CMS
//     marks an NPI inactive. NPPES does not say WHY an NPI is
//     deactivated. The conservative default is `LICENSE_EXPIRED`,
//     which is the broadest match (covers revocation, expiration,
//     voluntary surrender). DEA enrollment is a SEPARATE federal
//     registry and we never infer DEA status from NPI status.
//
//   - It does NOT auto-deactivate on `NOT_FOUND_AT_CMS`. An NPI in
//     our roster that CMS has no record of is almost always an
//     operator entry error in our system, not an actual deactivation
//     at CMS. Worker surfaces this for human review (same review
//     queue as reactivation candidates).
//
//   - It does NOT clear a local address when CMS reports a null
//     practice address. CMS occasionally scrubs address rows for
//     reasons unrelated to whether the practice still exists; the
//     "practice-still-exists" assumption is more useful than
//     trusting CMS to be authoritative on an absence.
//
//   - It does NOT do fancy normalization of postal codes, phones,
//     or addresses. `trim()` everywhere, uppercase state codes,
//     strict-equality after that. If false-positive UPDATEs show
//     up in production, we tighten in a later slice. Erring on
//     side of "noise an operator filters" beats "silent drift the
//     audit log can't explain".
//
// Action precedence when multiple conditions hold:
//   NOT_FOUND_AT_CMS
//     > ENUMERATION_TYPE_MISMATCH
//       > DEACTIVATE  (CMS inactive, we active)
//         > REACTIVATION_CANDIDATE  (CMS active, we inactive)
//           > UPDATE  (both active, field drift)
//             > NONE
// This ordering reflects "biggest data-integrity concern first":
//   - a stale NPI we should never have enrolled is the worst case;
//   - a wrong enumeration type is operator entry error;
//   - status transitions matter more than contact info drift
//     (no point updating an inactive provider's address);
//   - field updates matter more than no-ops.

import { ProviderStatus } from "@pharmax/database";

import type { PROVIDER_DEACTIVATION_REASONS } from "../commands/deactivate-provider.js";

// ---------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------

/** Local Provider row projection — only the columns the engine reads. */
export interface LocalProviderSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly npi: string;
  readonly status: ProviderStatus;
  readonly firstName: string;
  readonly lastName: string;
  readonly credential: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly phone: string | null;
}

/** CMS NPPES practice-address subset. */
export interface CmsAddress {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  /** 2-letter US state code from NPPES. */
  readonly stateCode: string;
  /** ZIP-5 or ZIP-9 ("12345" or "12345-6789"). */
  readonly postalCode: string;
  readonly phone: string | null;
}

/**
 * CMS NPPES record subset — what the engine reads from a CMS
 * response. Slice 2's HTTP client is responsible for parsing the
 * raw NPPES API JSON into this shape.
 */
export interface CmsNpiSnapshot {
  /** 10-digit NPI; must match `local.npi`. */
  readonly npi: string;
  /** NPI-1 = individual prescriber (what we expect). NPI-2 = organization. */
  readonly enumerationType: "NPI-1" | "NPI-2";
  /** NPPES status: "A" (active), "D" (deactivated). */
  readonly status: "A" | "D";
  /** First name from NPPES; null for NPI-2 records. */
  readonly firstName: string | null;
  /** Last name from NPPES; null for NPI-2 records. */
  readonly lastName: string | null;
  /** Credential string from NPPES (e.g. "MD", "DO", "NP"). */
  readonly credential: string | null;
  /** Primary practice address; null on rare CMS records with no practice. */
  readonly practiceAddress: CmsAddress | null;
  /** When CMS last updated this record (their `last_updated` field). */
  readonly lastUpdatedAtCms: Date;
}

// ---------------------------------------------------------------------
// Output: SyncAction discriminated union
// ---------------------------------------------------------------------

/** The engine's recommendation for what the worker should do. */
export type SyncAction =
  | SyncActionNone
  | SyncActionDeactivate
  | SyncActionUpdate
  | SyncActionReactivationCandidate
  | SyncActionNotFoundAtCms
  | SyncActionEnumerationTypeMismatch;

/** No diff; no action needed. */
export interface SyncActionNone {
  readonly kind: "NONE";
  readonly reason: "no_diff" | "both_inactive";
}

/**
 * CMS marked the NPI inactive; local row is still active. Worker
 * should dispatch `DeactivateProvider` with the default reason.
 *
 * Why `LICENSE_EXPIRED` and not `DEA_SURRENDERED_OR_REVOKED`:
 * NPPES "D" status does not say WHY the NPI is deactivated.
 * `LICENSE_EXPIRED` is the broadest match — it covers license
 * revocation, license expiration, and voluntary surrender (which
 * CMS reflects as inactive). DEA is a separate registry; we never
 * infer DEA status from NPI status. If the operator later knows
 * the real reason was DEA-related, they re-activate and
 * re-deactivate with the correct code (a small UX wart, acceptable
 * for the first slice; a future "edit deactivation reason" command
 * would smooth it).
 */
export interface SyncActionDeactivate {
  readonly kind: "DEACTIVATE";
  readonly reason: "LICENSE_EXPIRED";
  /**
   * Free-text reason text the worker passes to `DeactivateProvider`.
   * `DeactivateProvider` redacts `reasonText` from `command_log`,
   * so this string lives only in the command-log row's redacted
   * slot and the operator UI. The audit metadata and outbox carry
   * `hasReasonText: true` instead of the bytes. Encodes "this came
   * from automated sync" + the CMS timestamp so a human reviewing
   * the deactivation row knows it was machine-initiated.
   */
  readonly reasonText: string;
}

/** Field drift detected. Worker should dispatch `UpdateProvider`. */
export interface SyncActionUpdate {
  readonly kind: "UPDATE";
  readonly changes: ProviderUpdateChanges;
}

/**
 * CMS shows the NPI as active; local row is inactive. Worker
 * does NOT dispatch `ReactivateProvider` directly. Instead it
 * persists a "reactivation candidate" row (slice 3 schema) that
 * an operator reviews via the UI (slice 6) and confirms with the
 * appropriate `ProviderReactivationReason` code.
 *
 * Auto-reactivating is not safe — see the file header.
 */
export interface SyncActionReactivationCandidate {
  readonly kind: "REACTIVATION_CANDIDATE";
}

/**
 * NPI is in our roster but does not exist at CMS. Almost certainly
 * an operator entry error in our system, not an actual CMS removal.
 * Worker persists for human review (does NOT auto-deactivate).
 */
export interface SyncActionNotFoundAtCms {
  readonly kind: "NOT_FOUND_AT_CMS";
}

/**
 * NPI exists at CMS but is enumeration-type NPI-2 (organization),
 * while we only register NPI-1 (individual prescribers). Almost
 * certainly an operator entry error in our system. Worker persists
 * for human review (does NOT auto-deactivate — a partially-valid
 * NPI-2 row with wrong enumeration type is still data-integrity
 * cleanup, not a workflow concern).
 */
export interface SyncActionEnumerationTypeMismatch {
  readonly kind: "ENUMERATION_TYPE_MISMATCH";
  readonly cmsType: "NPI-2";
  readonly expected: "NPI-1";
}

/**
 * Shape of the `UpdateProvider` command input that the worker will
 * pass through. Mirrors the optional-field tri-state input of
 * `UpdateProvider` (undefined skips, null clears, value sets) but
 * narrowed to the fields the diff engine actually emits — name,
 * credential, and address columns. NPI is immutable; `deaNumber`
 * is not in NPPES; `email` is not in NPPES; `status` is owned by
 * the deactivate/reactivate commands.
 */
export interface ProviderUpdateChanges {
  firstName?: string;
  lastName?: string;
  credential?: string | null;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string | null;
}

// ---------------------------------------------------------------------
// Compile-time guards
// ---------------------------------------------------------------------

/**
 * Pin the engine's default deactivation reason to a real code in
 * the existing `PROVIDER_DEACTIVATION_REASONS` enum. If a future
 * refactor removes `LICENSE_EXPIRED` from the vocabulary, the
 * `satisfies` clause will fail at compile time, forcing us to
 * pick a new default consciously rather than silently emitting
 * an invalid action.
 */
const SYNC_DEFAULT_DEACTIVATION_REASON =
  "LICENSE_EXPIRED" satisfies (typeof PROVIDER_DEACTIVATION_REASONS)[number];

// ---------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------

/**
 * Compute the recommended sync action for a single (local row, CMS
 * snapshot) pair.
 *
 * Pure. Side-effect-free. Deterministic given the inputs.
 *
 * @param local - The Provider row from our DB (narrow projection).
 * @param cms - The CMS NPPES snapshot, or `null` if the NPI was not
 *              found at CMS at all.
 */
export function diffProviderAgainstCms(
  local: LocalProviderSnapshot,
  cms: CmsNpiSnapshot | null
): SyncAction {
  // Precedence step 1 — NPI does not exist at CMS at all.
  // Highest precedence: this is a data-integrity flag, not a
  // workflow transition. Worker surfaces for human review and does
  // not auto-anything.
  if (cms === null) {
    return { kind: "NOT_FOUND_AT_CMS" };
  }

  // Precedence step 2 — NPI is registered to an organization, not an
  // individual prescriber. Operator entry error. Surface for review.
  if (cms.enumerationType !== "NPI-1") {
    return {
      kind: "ENUMERATION_TYPE_MISMATCH",
      cmsType: cms.enumerationType,
      expected: "NPI-1",
    };
  }

  // Precedence step 3 — Status diffs trump field drift.
  const cmsInactive = cms.status === "D";
  const localInactive = local.status === ProviderStatus.INACTIVE;

  if (cmsInactive && !localInactive) {
    // CMS deactivated; we still have them active. Recommend
    // DeactivateProvider with the conservative default reason.
    return {
      kind: "DEACTIVATE",
      reason: SYNC_DEFAULT_DEACTIVATION_REASON,
      reasonText: buildSyncDeactivationReasonText(cms.status, cms.lastUpdatedAtCms),
    };
  }

  if (!cmsInactive && localInactive) {
    // CMS active; we have them inactive. Candidate for reactivation
    // but worker MUST hand off to a human (see file header).
    return { kind: "REACTIVATION_CANDIDATE" };
  }

  if (cmsInactive && localInactive) {
    // Both sides agree the provider is inactive. No further action.
    // Worker MAY still record a "checked" entry in `provider_sync_check`
    // (slice 3) for auditability but does NOT dispatch any command.
    return { kind: "NONE", reason: "both_inactive" };
  }

  // Both active. Compute the field-by-field diff.
  return diffFields(local, cms);
}

// ---------------------------------------------------------------------
// Field diff (both sides active)
// ---------------------------------------------------------------------

function diffFields(local: LocalProviderSnapshot, cms: CmsNpiSnapshot): SyncAction {
  const changes: ProviderUpdateChanges = {};

  // CMS NPI-1 records always have firstName/lastName populated; we
  // null-guard defensively (a malformed CMS row should produce a
  // no-op for that field rather than blow up).
  if (cms.firstName !== null) {
    const cmsFirst = cms.firstName.trim();
    if (cmsFirst.length > 0 && cmsFirst !== local.firstName.trim()) {
      changes.firstName = cmsFirst;
    }
  }
  if (cms.lastName !== null) {
    const cmsLast = cms.lastName.trim();
    if (cmsLast.length > 0 && cmsLast !== local.lastName.trim()) {
      changes.lastName = cmsLast;
    }
  }

  // Credential is nullable on both sides; tri-state diff (null vs
  // value vs same).
  const cmsCred = normalizeNullableString(cms.credential);
  const localCred = normalizeNullableString(local.credential);
  if (cmsCred !== localCred) {
    changes.credential = cmsCred;
  }

  // Address diff. Only runs when CMS reports an address. If
  // `cms.practiceAddress === null` we deliberately do NOT recommend
  // clearing local — see file header ("practice-still-exists"
  // assumption beats "trust CMS on an absence").
  if (cms.practiceAddress !== null) {
    diffAddress(local, cms.practiceAddress, changes);
  }

  if (Object.keys(changes).length === 0) {
    return { kind: "NONE", reason: "no_diff" };
  }

  return { kind: "UPDATE", changes };
}

function diffAddress(
  local: LocalProviderSnapshot,
  cmsAddr: CmsAddress,
  changes: ProviderUpdateChanges
): void {
  const cmsLine1 = cmsAddr.line1.trim();
  if (cmsLine1.length > 0 && cmsLine1 !== (local.addressLine1?.trim() ?? "")) {
    changes.addressLine1 = cmsLine1;
  }

  const cmsLine2 = normalizeNullableString(cmsAddr.line2);
  const localLine2 = normalizeNullableString(local.addressLine2);
  if (cmsLine2 !== localLine2) {
    changes.addressLine2 = cmsLine2;
  }

  const cmsCity = cmsAddr.city.trim();
  if (cmsCity.length > 0 && cmsCity !== (local.city?.trim() ?? "")) {
    changes.city = cmsCity;
  }

  const cmsState = cmsAddr.stateCode.trim().toUpperCase();
  const localState = local.state?.trim().toUpperCase() ?? "";
  if (cmsState.length > 0 && cmsState !== localState) {
    changes.state = cmsState;
  }

  const cmsPostal = cmsAddr.postalCode.trim();
  if (cmsPostal.length > 0 && cmsPostal !== (local.postalCode?.trim() ?? "")) {
    changes.postalCode = cmsPostal;
  }

  const cmsPhone = normalizeNullableString(cmsAddr.phone);
  const localPhone = normalizeNullableString(local.phone);
  if (cmsPhone !== localPhone) {
    changes.phone = cmsPhone;
  }
}

// ---------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------

/**
 * Trim + collapse empty strings to null. Used for nullable string
 * fields where "  " from CMS and `null` in our DB should both be
 * treated as "no value".
 */
function normalizeNullableString(s: string | null): string | null {
  if (s === null) return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ---------------------------------------------------------------------
// Reason-text builder (exported for slice 4 worker reuse)
// ---------------------------------------------------------------------

/**
 * Build the `reasonText` string passed to `DeactivateProvider` when
 * the engine emits a `DEACTIVATE` action. Format is stable so an
 * operator (or a future ops dashboard) can grep command_log entries
 * for sync-initiated deactivations and trace them back to a CMS
 * snapshot timestamp.
 *
 * The text is REDACTED from `command_log.requestPayload` by
 * `DeactivateProvider`'s `redactFields`, so it never lands in
 * forensic dumps; it survives only in the redacted slot + the
 * operator UI's "view rationale" affordance.
 *
 * Exported so the worker (slice 4) reuses the exact same format,
 * and so contract tests can pin the format without re-deriving it.
 */
export function buildSyncDeactivationReasonText(
  cmsStatus: "A" | "D",
  cmsLastUpdatedAt: Date
): string {
  return `NPPES status: ${cmsStatus} (CMS updated ${cmsLastUpdatedAt.toISOString()})`;
}
