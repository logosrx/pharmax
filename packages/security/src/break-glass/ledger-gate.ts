// The gate between human-typed free text and the break-glass ledger.
//
// `break_glass_session` / `break_glass_action` are THEMSELVES the
// append-only evidence record (SCHEMA.md "Audit surface"): DELETE is
// granted to no application role, actions are INSERT-only, and every
// session surfaces in the nightly security digest and the quarterly
// access-review evidence pack published to the Object-Locked archive.
// Text that enters here can never be deleted. PHI typed into a reason
// ("patient Jane Doe, DOB ..., order stuck") would become a HIPAA
// disclosure with no remediation path — crypto-shredding cannot reach
// it, and editing the row would falsify the ledger.
//
// The schema previously claimed these fields were "PHI-safe (enforced
// by Pino redaction at write time)". That was false comfort: Pino
// redaction masks LOG output; nothing screened the database write.
// This module is the real gate, applied at the module boundary — the
// only path to the tables — per the repo rule that backend validation
// is the source of truth.
//
// Three postures, matched to when the text arrives:
//
//   1. Session reasons are a CLOSED CODE LIST (same rationale as the
//      RBAC grant's `BREAK_GLASS_REASONS`: free-form reasons are
//      silently mis-classified in every report built on them). An
//      optional short detail rides along, bounded and tripwire-
//      screened. `other` without detail is refused — a session whose
//      stated purpose is "other" is a session with no stated purpose.
//   2. Resolutions and details are human-typed BEFORE the write, so a
//      tripwire hit REFUSES the write. The author is present and can
//      reword; nothing is lost.
//   3. Action error messages arrive AFTER the fact, from exception
//      text we do not control. Refusing would suppress the failure
//      ledger row — worse than the risk. A hit REDACTS the message,
//      naming the rules that fired, never the text.
//
// The tripwire itself (`phi.scanForPhi`) is shared platform-core
// machinery; see that module for what it is and is not. It is a
// last-resort shape check, not a PHI detector — the closed code list
// above is the control that does the real work.

import { errors, phi } from "@pharmax/platform-core";

import {
  BREAK_GLASS_LEDGER_TEXT_REJECTED,
  BREAK_GLASS_LEDGER_TEXT_TOO_LONG,
  BREAK_GLASS_SESSION_DETAIL_REQUIRED,
  BREAK_GLASS_SESSION_REASON_REQUIRED,
} from "./errors.js";

/**
 * Closed vocabulary for WHY a `pharmax_system` bypass session was
 * opened. Mirrors the style of `BREAK_GLASS_REASONS` in
 * @pharmax/rbac but names session-shaped work (cross-tenant
 * forensics and repair), not grant-shaped work (one actor, one
 * permission). Adding a code is a SOC 2 audit event; `other` with a
 * mandatory detail is the escape hatch.
 */
export const BREAK_GLASS_SESSION_REASONS = Object.freeze({
  TENANT_ISOLATION_INCIDENT: "tenant-isolation.incident",
  SECURITY_INCIDENT: "security.incident",
  DATA_REPAIR: "data.repair",
  STUCK_WORKFLOW_RECOVERY: "stuck-workflow.recovery",
  FORENSIC_INVESTIGATION: "forensic.investigation",
  RESTORE_DRILL: "restore.drill",
  OTHER: "other",
} as const);

export type BreakGlassSessionReasonCode =
  (typeof BREAK_GLASS_SESSION_REASONS)[keyof typeof BREAK_GLASS_SESSION_REASONS];

const ALL_SESSION_REASON_CODES = new Set<string>(Object.values(BREAK_GLASS_SESSION_REASONS));

/**
 * One or two sentences of operational context, not a narrative. The
 * ticket carries the story; a longer field invites exactly the
 * patient-specific detail the gate exists to keep out.
 */
export const BREAK_GLASS_DETAIL_MAX_LENGTH = 280;

/** Close-time summary. Longer than detail, still not an incident report. */
export const BREAK_GLASS_RESOLUTION_MAX_LENGTH = 2000;

/**
 * Serialized cap on `runAs` parameters. Parameters are meant to be
 * identifiers and switches ("orderId", "dryRun"), not payloads.
 */
export const BREAK_GLASS_PARAMETERS_MAX_BYTES = 4096;

function tripwireRejection(field: string, hits: ReadonlyArray<phi.TripwireHit>): never {
  // Names the rules, never the text: this message reaches logs, and
  // logging what we just refused to persist would defeat the gate.
  throw new errors.ValidationError({
    code: BREAK_GLASS_LEDGER_TEXT_REJECTED,
    message:
      `Break-glass ${field} looks like it carries patient data ` +
      `(matched: ${hits.map((h) => h.rule).join(", ")}). ` +
      `${hits.map((h) => h.explanation).join(" ")} ` +
      `This text would enter an append-only ledger that is published to write-once evidence ` +
      `storage — it can never be deleted. Refer to patients by order id or ticket, never by ` +
      `name, DOB, or contact details. If this is a false positive, reword rather than widening ` +
      `the rule.`,
    issues: [{ path: [field], message: "must not carry PHI-shaped text" }],
  });
}

function assertBounded(text: string, field: string, maxLength: number): void {
  if (text.length > maxLength) {
    throw new errors.ValidationError({
      code: BREAK_GLASS_LEDGER_TEXT_TOO_LONG,
      message:
        `Break-glass ${field} is ${text.length} characters; the cap is ${maxLength}. ` +
        `The ledger wants a pointer (ticket, order id), not a narrative — put the story ` +
        `in the ticket.`,
      issues: [{ path: [field], message: `must be ≤ ${maxLength} characters` }],
    });
  }
}

/**
 * Screen one human-typed free-text field bound for the ledger.
 * Refuses (throws) on over-length or PHI-shaped content.
 */
export function assertLedgerSafeText(text: string, field: string, maxLength: number): void {
  assertBounded(text, field, maxLength);
  const hits = phi.scanForPhi(text);
  if (hits.length > 0) tripwireRejection(field, hits);
}

/**
 * Validate the session reason and compose the string persisted in
 * `break_glass_session.reason`. The composed form is
 * `"<code>"` or `"<code>: <detail>"` — reports and the digest can
 * classify on the prefix while the row stays one column.
 */
export function composeSessionReason(reasonCode: string, reasonDetail: string | undefined): string {
  if (typeof reasonCode !== "string" || !ALL_SESSION_REASON_CODES.has(reasonCode)) {
    throw new errors.ValidationError({
      code: BREAK_GLASS_SESSION_REASON_REQUIRED,
      message:
        `openBreakGlassSession: reasonCode must be one of the registered session reason codes ` +
        `(${[...ALL_SESSION_REASON_CODES].join(", ")}). Free-form reasons are not accepted — ` +
        `the ledger is append-only and classification must not depend on prose.`,
      issues: [{ path: ["reasonCode"], message: "must be a registered code" }],
    });
  }

  const detail = reasonDetail?.trim();
  if (detail === undefined || detail.length === 0) {
    if (reasonCode === BREAK_GLASS_SESSION_REASONS.OTHER) {
      throw new errors.ValidationError({
        code: BREAK_GLASS_SESSION_DETAIL_REQUIRED,
        message:
          `openBreakGlassSession: reasonCode "other" requires reasonDetail — a session whose ` +
          `stated purpose is "other" is a session with no stated purpose.`,
        issues: [{ path: ["reasonDetail"], message: 'required when reasonCode is "other"' }],
      });
    }
    return reasonCode;
  }

  assertLedgerSafeText(detail, "reasonDetail", BREAK_GLASS_DETAIL_MAX_LENGTH);
  return `${reasonCode}: ${detail}`;
}

/**
 * Screen `runAs` parameters before the wrapped operation executes.
 * Every string in the structure — keys and values, at any depth — is
 * tripwire-screened, and the serialized whole is size-capped.
 * SCHEMA.md says "caller is responsible for redaction"; this makes
 * the caller's failure to do so loud instead of silent.
 */
export function assertLedgerSafeParameters(parameters: unknown): void {
  if (parameters === null || parameters === undefined) return;

  let serialized: string;
  try {
    serialized = JSON.stringify(parameters) ?? "";
  } catch (cause) {
    throw new errors.ValidationError({
      code: BREAK_GLASS_LEDGER_TEXT_REJECTED,
      message:
        "Break-glass action parameters must be JSON-serializable — they are persisted verbatim " +
        "to the append-only action ledger.",
      issues: [{ path: ["parameters"], message: "must be JSON-serializable" }],
      cause,
    });
  }

  if (serialized.length > BREAK_GLASS_PARAMETERS_MAX_BYTES) {
    throw new errors.ValidationError({
      code: BREAK_GLASS_LEDGER_TEXT_TOO_LONG,
      message:
        `Break-glass action parameters serialize to ${serialized.length} bytes; the cap is ` +
        `${BREAK_GLASS_PARAMETERS_MAX_BYTES}. Parameters are identifiers and switches, not ` +
        `payloads — persist large inputs elsewhere and reference them.`,
      issues: [
        {
          path: ["parameters"],
          message: `must serialize to ≤ ${BREAK_GLASS_PARAMETERS_MAX_BYTES} bytes`,
        },
      ],
    });
  }

  screenValue(parameters, "parameters");
}

function screenValue(value: unknown, path: string): void {
  if (typeof value === "string") {
    const hits = phi.scanForPhi(value);
    if (hits.length > 0) tripwireRejection(path, hits);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => screenValue(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const hits = phi.scanForPhi(key);
      if (hits.length > 0) tripwireRejection(`${path}.${key} (key)`, hits);
      screenValue(entry, `${path}.${key}`);
    }
  }
}

/**
 * Post-hoc screen for action error messages. These come from
 * exception text we do not control, AFTER the operation ran —
 * refusing here would suppress the failure ledger row, which is
 * worse than the risk. A hit redacts the message, naming the rules
 * that fired so the session reviewer knows something was withheld
 * and why.
 */
export function redactErrorMessageForLedger(message: string): string {
  const truncated =
    message.length > BREAK_GLASS_RESOLUTION_MAX_LENGTH
      ? `${message.slice(0, BREAK_GLASS_RESOLUTION_MAX_LENGTH)}…`
      : message;
  const hits = phi.scanForPhi(truncated);
  if (hits.length === 0) return truncated;
  return `[redacted: error text matched PHI tripwire rules ${hits.map((h) => h.rule).join(", ")}]`;
}
