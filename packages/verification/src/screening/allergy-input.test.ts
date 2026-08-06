// Vocabulary parity between the Prisma enums and the screening unions.
//
// `allergy-input.ts` maps a `patient_allergy` row straight into the
// engine's `RecordedAllergy` with no casts and no translation table,
// which is only sound because the two vocabularies are member-for-member
// identical. That identity is currently maintained by hand in two files
// that cannot import each other: `prisma/schema.prisma` (Postgres enums)
// and `@pharmax/clinical-screening/allergy.ts` (string unions, kept free
// of Prisma so the engine stays dependency-less).
//
// Two files, one invariant, no compiler link between them — the same
// shape of gap that let a stale availability constant survive. So it
// gets a test.
//
// WHAT GOES WRONG WITHOUT IT. Add a category — say `PROCEDURE` — to the
// Prisma enum only, and a row carrying it reaches
// `isScreenableAllergyCategory`, whose `switch` has no case for it and
// whose `never` default returns `undefined`. `isScreenableAllergy` then
// answers falsy, the record is dropped from the screen, and NOTHING
// reports that: the patient looks like one with no screenable allergies,
// which is a state the system already knows how to render calmly. The
// failure is silent and in the unsafe direction.

import { describe, expect, it } from "vitest";

import {
  ALLERGY_CATEGORIES,
  ALLERGY_CLINICAL_STATUSES,
  ALLERGY_CRITICALITIES,
  ALLERGY_SUBSTANCE_CODE_SYSTEMS,
  ALLERGY_TYPES,
  ALLERGY_VERIFICATION_STATUSES,
} from "@pharmax/clinical-screening";
import {
  AllergyCategory,
  AllergyClinicalStatus,
  AllergyCriticality,
  AllergyIntoleranceType,
  AllergySubstanceCodeSystem,
  AllergyVerificationStatus,
} from "@pharmax/database";

const sorted = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...values].sort((a, b) => a.localeCompare(b));

describe("allergy vocabulary parity — Prisma enum vs screening union", () => {
  const pairs: ReadonlyArray<
    readonly [string, Readonly<Record<string, string>>, ReadonlyArray<string>]
  > = [
    ["AllergyCategory", AllergyCategory, ALLERGY_CATEGORIES],
    ["AllergyIntoleranceType", AllergyIntoleranceType, ALLERGY_TYPES],
    ["AllergyCriticality", AllergyCriticality, ALLERGY_CRITICALITIES],
    ["AllergyClinicalStatus", AllergyClinicalStatus, ALLERGY_CLINICAL_STATUSES],
    ["AllergyVerificationStatus", AllergyVerificationStatus, ALLERGY_VERIFICATION_STATUSES],
    ["AllergySubstanceCodeSystem", AllergySubstanceCodeSystem, ALLERGY_SUBSTANCE_CODE_SYSTEMS],
  ];

  for (const [name, prismaEnum, screeningUnion] of pairs) {
    it(`${name} has exactly the members the screening union does`, () => {
      expect(
        sorted(Object.values(prismaEnum)),
        `${name} and its @pharmax/clinical-screening counterpart have diverged. ` +
          "A member present in only one of them is silently dropped from allergy " +
          "screening — the record stops being compared and nothing reports it. " +
          "Add it to both, and give it a case in the matching screenability switch."
      ).toEqual(sorted(screeningUnion));
    });
  }
});
