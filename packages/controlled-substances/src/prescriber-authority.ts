// Does this prescriber hold DEA authority for this schedule?
//
// Pure, like the rest of this package: it takes the registration facts
// and a clock reading, and returns a verdict. It performs no I/O and
// knows nothing about Prisma — the caller loads the rows.
//
// WHY THIS LIVES HERE rather than in `@pharmax/providers`, which owns
// the model. `create-prescription.ts` is the caller, and both `orders`
// and `providers` are domain packages: an `orders -> providers` edge
// would have to be added to the frozen contract in
// `check-package-layers.ts`, which the Tier-2 plan is trying to shrink
// rather than grow. `orders` already depends on this package, and "what
// authority does a DEA registration confer" is a statement about
// federal law, which is what this package is for.
//
// WHAT REPLACED WHAT. The old gate read a nullable string column and
// asked whether it was non-blank. That could not express three things
// that decide whether a controlled prescription is lawful:
//
//   * the registration may have lapsed;
//   * the DEA may have revoked or suspended it;
//   * it may not cover the schedule being prescribed.
//
// Each is now a distinct refusal reason, because the operator's next
// action differs for each and a single "no DEA on file" message would
// send them to fix the wrong thing.

import { CredentialStatus, type ControlledSubstanceSchedule } from "@pharmax/database";

import { isControlled } from "./schedule.js";

/** Why a prescriber may not write for this schedule. */
export const DEA_AUTHORITY_NO_REGISTRATION = "DEA_AUTHORITY_NO_REGISTRATION" as const;
export const DEA_AUTHORITY_EXPIRED = "DEA_AUTHORITY_EXPIRED" as const;
export const DEA_AUTHORITY_NOT_ACTIVE = "DEA_AUTHORITY_NOT_ACTIVE" as const;
export const DEA_AUTHORITY_SCHEDULE_NOT_AUTHORIZED =
  "DEA_AUTHORITY_SCHEDULE_NOT_AUTHORIZED" as const;

export type DeaAuthorityRefusalCode =
  | typeof DEA_AUTHORITY_NO_REGISTRATION
  | typeof DEA_AUTHORITY_EXPIRED
  | typeof DEA_AUTHORITY_NOT_ACTIVE
  | typeof DEA_AUTHORITY_SCHEDULE_NOT_AUTHORIZED;

/**
 * The subset of a `provider_dea_registration` row this evaluation
 * needs. Structural rather than the Prisma type so the package stays
 * free of a database dependency at the type level too.
 */
export interface PrescriberDeaRegistrationFacts {
  readonly deaNumber: string;
  readonly status: CredentialStatus;
  /**
   * Null means the expiry was never recorded — common for a pharmacy
   * migrating on with numbers but no dates. Null does NOT block; see
   * the model comment for why treating it as expired would take every
   * tenant's controlled prescribing offline on day one.
   */
  readonly expiresAt: Date | null;
  readonly authorizedSchedules: ReadonlyArray<ControlledSubstanceSchedule>;
}

export interface DeaAuthorityGranted {
  readonly ok: true;
  /**
   * The registration that authorized it. Recorded on the prescription's
   * audit row so "which credential was relied on" is answerable later,
   * when the prescriber may hold several or none.
   */
  readonly deaNumber: string;
}

export interface DeaAuthorityRefused {
  readonly ok: false;
  readonly code: DeaAuthorityRefusalCode;
  /** How many registrations existed at all, live or not. */
  readonly registrationCount: number;
}

export type DeaAuthorityVerdict = DeaAuthorityGranted | DeaAuthorityRefused;

export interface EvaluatePrescriberDeaAuthorityInput {
  readonly schedule: ControlledSubstanceSchedule;
  readonly registrations: ReadonlyArray<PrescriberDeaRegistrationFacts>;
  /** Injected, never `new Date()` — this package holds no clock. */
  readonly asOf: Date;
}

/**
 * Evaluate whether any of a prescriber's DEA registrations authorizes
 * the given schedule as of `asOf`.
 *
 * A non-controlled schedule always passes: no DEA registration is
 * required to write an ordinary prescription, and demanding one would
 * block most of the catalog.
 *
 * When several registrations exist, the FIRST that authorizes wins —
 * a prescriber holding both a mid-level and a practitioner number
 * needs only one of them to cover the schedule. The refusal code
 * reported when none do is the most specific one available, ordered so
 * the operator is told the thing they can act on: a schedule that is
 * simply not covered is more actionable than an expiry, which is more
 * actionable than "nothing on file".
 */
export function evaluatePrescriberDeaAuthority(
  input: EvaluatePrescriberDeaAuthorityInput
): DeaAuthorityVerdict {
  if (!isControlled(input.schedule)) {
    return { ok: true, deaNumber: "" };
  }

  const registrationCount = input.registrations.length;
  if (registrationCount === 0) {
    return { ok: false, code: DEA_AUTHORITY_NO_REGISTRATION, registrationCount };
  }

  let sawActive = false;
  let sawUnexpired = false;

  for (const registration of input.registrations) {
    if (registration.status !== CredentialStatus.ACTIVE) continue;
    sawActive = true;

    // A recorded date that has passed blocks. A null date does not —
    // it means nobody has entered one yet, which is a gap to close
    // rather than a lapse to enforce.
    if (
      registration.expiresAt !== null &&
      registration.expiresAt.getTime() < input.asOf.getTime()
    ) {
      continue;
    }
    sawUnexpired = true;

    if (registration.authorizedSchedules.includes(input.schedule)) {
      return { ok: true, deaNumber: registration.deaNumber };
    }
  }

  // Ordered most-actionable first. "Your registration doesn't cover
  // CII" tells the operator something different from "it lapsed",
  // which differs again from "there isn't one".
  if (sawUnexpired) {
    return { ok: false, code: DEA_AUTHORITY_SCHEDULE_NOT_AUTHORIZED, registrationCount };
  }
  if (sawActive) {
    return { ok: false, code: DEA_AUTHORITY_EXPIRED, registrationCount };
  }
  return { ok: false, code: DEA_AUTHORITY_NOT_ACTIVE, registrationCount };
}
