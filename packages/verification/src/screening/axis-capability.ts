// What this platform can supply to each clinical-screening axis — as a
// CLAIM ABOUT THE SCHEMA that a test checks against the schema.
//
// =====================================================================
// THE BUG THIS FILE EXISTS TO MAKE IMPOSSIBLE
// =====================================================================
//
// Before this module, `run-screen.ts` held a frozen literal:
//
//     DRUG_ALLERGY: "NOT_SUPPORTED_BY_PLATFORM",   // no allergy table
//     DOSE_RANGE:   "NOT_SUPPORTED_BY_PLATFORM",   // no structured sig
//
// Both lines were true when written, and both carried a comment
// promising they would be revisited when the schema gained the missing
// piece. That promise had no enforcement behind it. Adding a
// `patient_allergy` table breaks NOTHING: the constant still compiles,
// every test still passes, and the allergy axis goes on reporting
// "this platform has no capability to supply that input for any
// subject" while the capability sits in the schema unused. Nobody gets
// an error. The screen stays dark and reads as if somebody decided it
// should be.
//
// A comment is not a forcing function. What makes this class of bug
// recur is that the declaration and the reality it describes live in
// different files with no link between them, so the only thing keeping
// them in sync is whether the next engineer reads a comment.
//
// So the declaration below does not say "unavailable". It says WHICH
// SCHEMA WOULD HAVE TO EXIST, and `axis-capability.test.ts` asserts
// each claim against the generated Prisma client:
//
//   - an axis declared supported must have its schema present;
//   - an axis declared NOT_SUPPORTED_BY_PLATFORM must have its schema
//     ABSENT.
//
// The second assertion is the forcing function. The day somebody adds
// `dose_amount` / `dose_unit` / `doses_per_day` to `prescription`, the
// DOSE_RANGE claim becomes false and the test fails with an error that
// names the axis and says what to do. That engineer cannot ship a
// structured sig and leave dose screening dark, because the thing that
// silenced the axis was a statement about the schema they just changed.
//
// WHY THE SCHEMA AND NOT SOMETHING ELSE. Three candidates were
// considered:
//
//   1. Derive availability at runtime from the schema. Rejected: a
//      table existing does not mean any code reads it. Runtime
//      derivation would have flipped DRUG_ALLERGY to AVAILABLE the
//      moment the migration landed, before a single row was ever
//      loaded — asserting a screen against an empty array, which is
//      the original bug with more machinery.
//   2. A checklist in an ADR or a TODO comment. Rejected: that is what
//      was already there.
//   3. Declare the capability and CHECK it against the schema. Chosen.
//      The declaration stays hand-written (so gaining a table cannot
//      silently promote an axis), but a hand-written declaration that
//      has gone stale FAILS rather than shipping.
//
// The remaining honest limitation: this proves the schema exists and
// that a probe is wired, not that the probe is correct. Correctness of
// the probe is `allergy-input.test.ts`'s job. What it does buy is that
// no axis can sit at NOT_SUPPORTED_BY_PLATFORM once the platform
// supports it, which is the failure that actually happened.

import type { ScreeningInputAvailability, ScreeningInputAxis } from "@pharmax/clinical-screening";
import { CLINICAL_SCREENING_AXES } from "@pharmax/clinical-screening";
import { Prisma } from "@pharmax/database";

import { hasScreenableAllergyInput, type PatientScreeningScope } from "./allergy-input.js";

/**
 * Schema a capability claim depends on: a Prisma model and the fields
 * on it that matter. Named in terms of the Prisma model rather than the
 * SQL table so the test can check it against the generated client
 * without parsing `schema.prisma`.
 */
export interface SchemaEvidence {
  readonly model: string;
  readonly fields: ReadonlyArray<string>;
}

/**
 * What a probe gets: one patient, inside the caller's transaction.
 *
 * Re-exported from `allergy-input.ts` rather than declared here, so the
 * dependency runs one way (capability -> input loaders) and a probe
 * module never has to import the declaration that calls it.
 */
export type SubjectProbeInput = PatientScreeningScope;

/**
 * Why an axis has the availability it has.
 *
 * Three kinds, and the distinction between the first two is the one
 * that gets skipped. Both are "supported"; they differ on what an
 * EMPTY result means.
 */
export type ScreeningAxisCapability =
  | {
      /**
       * The platform holds the COMPLETE set by construction, so an
       * empty result is a fact rather than an unknown, and the axis is
       * always AVAILABLE.
       *
       * True of the medication profile: a prescription is BORN in
       * Pharmax. If a patient has no active prescriptions, they have no
       * active prescriptions — there is no elsewhere for one to be
       * hiding. Nothing needs asking, so there is nothing to gap.
       */
      readonly kind: "ALWAYS_AVAILABLE";
      readonly requiresSchema: ReadonlyArray<SchemaEvidence>;
      readonly rationale: string;
    }
  | {
      /**
       * The platform CAN hold this input, but an empty result is
       * ambiguous between "asked, nothing found" and "nobody asked", so
       * a per-patient probe has to decide.
       *
       * True of allergies: an allergy is REPORTED TO Pharmax by a human
       * who may never have been asked. Absence of a row is not absence
       * of an allergy. That asymmetry with the profile axes above is
       * the entire reason `NOT_RECORDED_FOR_SUBJECT` exists.
       *
       * The probe lives ON the declaration rather than in a lookup
       * table beside it, so an axis cannot be moved to PER_SUBJECT
       * without one. That is a compile error, not a review comment.
       */
      readonly kind: "PER_SUBJECT";
      readonly requiresSchema: ReadonlyArray<SchemaEvidence>;
      readonly rationale: string;
      /** True → AVAILABLE. False → NOT_RECORDED_FOR_SUBJECT. */
      readonly probe: (input: SubjectProbeInput) => Promise<boolean>;
    }
  | {
      /**
       * The platform cannot supply this for ANY patient, and the schema
       * named in `absentSchema` is why.
       *
       * `absentSchema` is checked by the test: the claim is honest only
       * while that schema is NOT fully present. When it becomes
       * present, the test fails and this entry has to be converted to
       * PER_SUBJECT (or ALWAYS_AVAILABLE) with a probe.
       */
      readonly kind: "NOT_SUPPORTED_BY_PLATFORM";
      readonly absentSchema: ReadonlyArray<SchemaEvidence>;
      readonly rationale: string;
      /**
       * What the engineer who trips the forcing function has to do.
       * Printed in the failure, because a test that fails without
       * saying what to do next gets deleted.
       */
      readonly whenSchemaArrives: string;
    };

// ---------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------

/**
 * Keyed by `ScreeningInputAxis`, which is DERIVED from
 * `SCREENING_FINDING_KINDS`. A fifth axis added to the engine therefore
 * makes this map incomplete and fails to compile until somebody states
 * what Pharmax can say about it — the same forcing function
 * `ScreeningRequest.inputAvailability` already applies at call sites,
 * reused here so a new axis cannot default to the unsafe answer.
 */
export const SCREENING_AXIS_CAPABILITY: Readonly<
  Record<ScreeningInputAxis, ScreeningAxisCapability>
> = Object.freeze({
  DRUG_DRUG_INTERACTION: Object.freeze({
    kind: "ALWAYS_AVAILABLE",
    requiresSchema: Object.freeze([
      Object.freeze({
        model: "Prescription",
        fields: Object.freeze(["patientId", "drugNdc", "status"]),
      }),
    ]),
    rationale:
      "The profile is the patient's other ACTIVE prescriptions, and prescriptions originate in Pharmax. No active prescriptions means no active prescriptions; there is nobody to ask and nothing to gap.",
  }),

  THERAPEUTIC_DUPLICATION: Object.freeze({
    kind: "ALWAYS_AVAILABLE",
    requiresSchema: Object.freeze([
      Object.freeze({
        model: "Prescription",
        fields: Object.freeze(["patientId", "drugNdc", "status"]),
      }),
    ]),
    rationale:
      "Same input as DRUG_DRUG_INTERACTION, declared separately because the engine lets a caller hold a medication list good enough for one and not the other.",
  }),

  DRUG_ALLERGY: Object.freeze({
    kind: "PER_SUBJECT",
    requiresSchema: Object.freeze([
      Object.freeze({
        model: "PatientAllergy",
        fields: Object.freeze([
          "patientId",
          "substanceCode",
          "substanceCodeSystem",
          "category",
          "clinicalStatus",
          "verificationStatus",
        ]),
      }),
      Object.freeze({
        model: "PatientAllergyHistoryAssertion",
        fields: Object.freeze(["patientId", "status", "assertedAt"]),
      }),
    ]),
    rationale:
      "An allergy is reported to Pharmax rather than created in it, so an empty list does not mean an allergy-free patient. AVAILABLE requires either at least one screenable record or an explicit NO_KNOWN_ALLERGIES assertion; anything else is NOT_RECORDED_FOR_SUBJECT, which is actionable and therefore interrupts.",
    probe: hasScreenableAllergyInput,
  }),

  DOSE_RANGE: Object.freeze({
    kind: "NOT_SUPPORTED_BY_PLATFORM",
    absentSchema: Object.freeze([
      Object.freeze({
        model: "Prescription",
        // `sigEnc` is encrypted free text. A dose comparison needs an
        // amount, a unit and a frequency as separate values; parsing
        // them out of a sig inside a safety check is how a wrong
        // mg/mcg factor becomes a hazard.
        fields: Object.freeze(["doseAmount", "doseUnit", "dosesPerDay"]),
      }),
    ]),
    rationale:
      "`prescription.sigEnc` is encrypted free text with no structured amount/unit/frequency beside it, so no prescription in this schema carries a dose the engine could compare against a published range.",
    whenSchemaArrives:
      "Structured sig columns now exist on Prescription, so this axis is no longer unsupportable. Convert DOSE_RANGE to kind PER_SUBJECT with a probe that answers whether THIS prescription carries a parseable dose (AVAILABLE) or does not (NOT_RECORDED_FOR_SUBJECT), and pass a DoseStatement on the PrescribedDrug in run-screen.ts. Do not simply flip it to ALWAYS_AVAILABLE: a prescription with a PRN sig and no schedule has no daily total, and claiming otherwise would screen it against a fictional zero.",
  }),
});

// ---------------------------------------------------------------------
// Resolving availability for one patient
// ---------------------------------------------------------------------

/**
 * The availability map to hand `screenPrescription`, computed for THIS
 * patient.
 *
 * Replaces the module constant that used to sit in `run-screen.ts`.
 * Nothing here decides policy — the policy is the declaration above;
 * this only executes it.
 */
export async function resolveInputAvailability(
  input: SubjectProbeInput
): Promise<Readonly<Record<ScreeningInputAxis, ScreeningInputAvailability>>> {
  const out: Partial<Record<ScreeningInputAxis, ScreeningInputAvailability>> = {};

  for (const axis of CLINICAL_SCREENING_AXES) {
    const capability = SCREENING_AXIS_CAPABILITY[axis];
    switch (capability.kind) {
      case "ALWAYS_AVAILABLE":
        out[axis] = "AVAILABLE";
        break;
      case "PER_SUBJECT":
        out[axis] = (await capability.probe(input)) ? "AVAILABLE" : "NOT_RECORDED_FOR_SUBJECT";
        break;
      case "NOT_SUPPORTED_BY_PLATFORM":
        out[axis] = "NOT_SUPPORTED_BY_PLATFORM";
        break;
      default: {
        const exhaustive: never = capability;
        return exhaustive;
      }
    }
  }

  return Object.freeze(out as Record<ScreeningInputAxis, ScreeningInputAvailability>);
}

// ---------------------------------------------------------------------
// Checking the declaration against reality
// ---------------------------------------------------------------------

/**
 * What the generated Prisma client knows about the schema's shape.
 *
 * Abstracted behind an interface so the mismatch finder is a pure
 * function a test can drive with a synthetic schema — otherwise the
 * only way to test the forcing function would be to actually add a
 * column, which is exactly the event it is supposed to catch.
 */
export interface SchemaReality {
  hasModel(model: string): boolean;
  hasField(model: string, field: string): boolean;
}

/**
 * `SchemaReality` backed by the generated client.
 *
 * Prisma 7 removed the runtime `Prisma.dmmf` value, but it still emits
 * a `<Model>ScalarFieldEnum` object per model, whose keys are that
 * model's scalar and enum fields. That is a runtime view of the schema
 * with no dependency on `@prisma/internals` and no file parsing —
 * which matters, because a check that has to locate `schema.prisma` on
 * disk breaks the moment it runs from somewhere unexpected, and a
 * forcing function that breaks gets disabled.
 */
export function prismaSchemaReality(): SchemaReality {
  const namespace = Prisma as unknown as Record<string, unknown>;
  const modelNames = new Set(
    Object.values((namespace["ModelName"] ?? {}) as Record<string, string>)
  );

  const fieldsOf = (model: string): ReadonlySet<string> | null => {
    const fieldEnum = namespace[`${model}ScalarFieldEnum`];
    if (fieldEnum === undefined || fieldEnum === null || typeof fieldEnum !== "object") {
      return null;
    }
    return new Set(Object.keys(fieldEnum as Record<string, unknown>));
  };

  return {
    hasModel: (model) => modelNames.has(model),
    hasField: (model, field) => fieldsOf(model)?.has(field) === true,
  };
}

export type CapabilityMismatchKind =
  /** An axis claims support but the schema it needs is missing. */
  | "REQUIRED_SCHEMA_MISSING"
  /** An axis claims the platform cannot support it, but it now can. */
  | "ABSENT_SCHEMA_NOW_PRESENT";

export interface CapabilityMismatch {
  readonly axis: ScreeningInputAxis;
  readonly kind: CapabilityMismatchKind;
  readonly message: string;
}

function isFullyPresent(evidence: SchemaEvidence, reality: SchemaReality): boolean {
  if (!reality.hasModel(evidence.model)) return false;
  return evidence.fields.every((field) => reality.hasField(evidence.model, field));
}

function describeMissing(evidence: SchemaEvidence, reality: SchemaReality): string {
  if (!reality.hasModel(evidence.model)) return `model ${evidence.model} does not exist`;
  const missing = evidence.fields.filter((field) => !reality.hasField(evidence.model, field));
  return `${evidence.model} is missing field(s) ${missing.join(", ")}`;
}

/**
 * Every place the declaration and the schema disagree.
 *
 * PURE. Takes the capability map and a `SchemaReality`, returns
 * findings. That shape is what lets the test prove the forcing function
 * FIRES — feed it a synthetic reality in which the dose columns exist
 * and assert a mismatch comes back — rather than merely proving it is
 * quiet today, which is what a check wired straight to the live schema
 * could show.
 *
 * The `ABSENT_SCHEMA_NOW_PRESENT` rule triggers only when ALL of an
 * entry's fields are present, not when any one is. A half-built
 * structured sig cannot supply a dose either, and failing the build
 * partway through somebody's migration would teach them to edit the
 * declaration to make the noise stop — which is the outcome this is
 * trying to prevent.
 */
export function findCapabilityMismatches(
  capabilities: Readonly<Record<ScreeningInputAxis, ScreeningAxisCapability>>,
  reality: SchemaReality
): ReadonlyArray<CapabilityMismatch> {
  const out: CapabilityMismatch[] = [];

  for (const axis of CLINICAL_SCREENING_AXES) {
    const capability = capabilities[axis];

    if (capability.kind === "NOT_SUPPORTED_BY_PLATFORM") {
      for (const evidence of capability.absentSchema) {
        if (!isFullyPresent(evidence, reality)) continue;
        out.push({
          axis,
          kind: "ABSENT_SCHEMA_NOW_PRESENT",
          message:
            `${axis} is declared NOT_SUPPORTED_BY_PLATFORM because ${evidence.model}.` +
            `{${evidence.fields.join(", ")}} does not exist — but it now does. ` +
            `The declaration is no longer true, and until it is fixed this axis reports ` +
            `"no screen can perform this check" on every order while the data sits unused. ` +
            capability.whenSchemaArrives,
        });
      }
      continue;
    }

    for (const evidence of capability.requiresSchema) {
      if (isFullyPresent(evidence, reality)) continue;
      out.push({
        axis,
        kind: "REQUIRED_SCHEMA_MISSING",
        message:
          `${axis} is declared ${capability.kind} and depends on schema that is absent: ` +
          `${describeMissing(evidence, reality)}. Either restore the schema or change the ` +
          `declaration — an axis that claims to be screened against data it cannot read ` +
          `reports a clean screen that never ran.`,
      });
    }
  }

  return out;
}
