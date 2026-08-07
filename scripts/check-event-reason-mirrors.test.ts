// Cross-package parity for closed reason-code enums, with
// `@pharmax/verification` as the source of truth. Two families of
// mirror are pinned here:
//
//   1. The local `const` mirrors inside
//      `@pharmax/events/events/order/*.ts` payload schemas.
//   2. The PV1 rejection-reason HINTS in
//      `@pharmax/clinical-screening`, which suggests a reason code
//      for each screening finding kind so the console can preselect
//      one when a pharmacist rejects on the strength of a finding.
//
// Why this lives in `scripts/` and NOT inside either package:
//
//   - Putting it inside `@pharmax/events` would require importing
//     from `@pharmax/verification`, which would create a cycle —
//     domain packages already depend on `@pharmax/events` to emit,
//     so the reverse edge can't exist.
//   - Putting it inside `@pharmax/verification` would require
//     adding `@pharmax/events` as a devDependency just for the
//     test, which adds a graph edge a future contributor might
//     interpret as a permission to import event helpers at runtime.
//     The same objection applies to `@pharmax/clinical-screening`:
//     the layer linter would permit that edge (screening is a
//     low-tier pure package, not a domain), but verification does
//     not depend on screening at runtime TODAY, and a manifest
//     entry claiming otherwise would be read as licence to call it
//     from a command handler before that integration is designed.
//   - Putting it at the repo root (where every workspace is
//     already a devDependency of `pharmax`) lets the test reach
//     both sides without altering the package dependency surface.
//
// Why this matters:
//
//   Each event payload schema in `@pharmax/events` mirrors the
//   reason-code enum as a local `const` (vs. importing from the
//   domain package). Without this test, a maintainer could add a
//   new reason to `@pharmax/verification` (e.g.
//   `PV1_REJECTION_REASONS += "EXPIRED_PRESCRIPTION"`) without
//   updating the event-side mirror. The new code would pass Zod
//   on the producer side and FAIL Zod on the consumer (drainer)
//   side — a silent split-brain that surfaces only when a real
//   outbox row gets the new reason.
//
// What this test pins:
//
//   For each (canonical list, event payload schema field) pair we
//   ship today, the mirror inside the schema MUST be deep-equal to
//   the canonical list — same length, same order, same values.
//
// How to recover when this fails:
//
//   The failure message will print both arrays. Edit the
//   corresponding `events/order/<name>-v1.ts` mirror to match
//   `@pharmax/verification/src/{missing-info-reasons,rejection-reasons}.ts`
//   (or vice versa). The two lists ARE the same vocabulary by
//   design; they only live in two places because of the
//   dependency-direction constraint above.

import { describe, expect, it } from "vitest";

import {
  suggestedPv1RejectionReason,
  SCREENING_FINDING_KINDS,
  SUGGESTED_PV1_REJECTION_REASONS,
} from "@pharmax/clinical-screening";
import {
  OrderPv1RejectedV1,
  OrderFinalRejectedV1,
  OrderTypingMissingInfoV1,
} from "@pharmax/events";
import { MISSING_INFO_REASONS } from "@pharmax/verification";
import { FINAL_REJECTION_REASONS, PV1_REJECTION_REASONS } from "@pharmax/verification";

/**
 * Pull the Zod enum's value array out of a payload schema's
 * named field. Returns a frozen, alphabetically-sorted list of
 * the enum's values for set-equality comparison.
 *
 * We compare sorted snapshots (not raw order) because the
 * canonical source-of-truth lists are ordered by frequency-of-use
 * for UX, and the event payload mirrors do NOT need to preserve
 * that ordering to be semantically equivalent — the enum is a
 * SET, not a sequence. If a future requirement pins ordering
 * (e.g. for stable JSON snapshots), tighten this to ===.
 */
function extractEnumValuesFromSchema(schema: unknown, fieldName: string): ReadonlyArray<string> {
  // Zod 4 public introspection surface:
  //   - `ZodObject.shape` is a plain getter returning the field
  //     map `{ [k: string]: ZodType }`. (NOT a method like in Zod
  //     3 — `_def.shape()` would throw a TypeError here.)
  //   - `ZodEnum.options` is a plain getter returning the
  //     readonly value array. Mirrors the public Zod 4 docs and
  //     matches the runtime shape (`_def.entries` is the
  //     value-to-value mapping, also readable).
  //
  // We use the public getters (not `_def`) so a Zod minor bump
  // that reshuffles `_def` does not break this parity test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shape: Record<string, any> | undefined = (schema as any).shape;
  if (shape === undefined || shape === null) {
    throw new Error(
      `extractEnumValuesFromSchema: schema does not expose a .shape getter — is this a ZodObject?`
    );
  }
  const field = shape[fieldName];
  if (field === undefined) {
    throw new Error(`extractEnumValuesFromSchema: schema has no field "${fieldName}"`);
  }
  const values: ReadonlyArray<string> | undefined =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (field as any).options;
  if (values === undefined) {
    throw new Error(
      `extractEnumValuesFromSchema: field "${fieldName}" is not a ZodEnum (no .options getter)`
    );
  }
  return Object.freeze([...values].sort());
}

describe("event reason-code mirrors mirror @pharmax/verification", () => {
  it("OrderPv1RejectedV1.reasonCode mirrors PV1_REJECTION_REASONS", () => {
    const mirror = extractEnumValuesFromSchema(OrderPv1RejectedV1.schema, "reasonCode");
    const source = Object.freeze([...PV1_REJECTION_REASONS].sort());
    expect(mirror).toEqual(source);
  });

  it("OrderFinalRejectedV1.reasonCode mirrors FINAL_REJECTION_REASONS", () => {
    const mirror = extractEnumValuesFromSchema(OrderFinalRejectedV1.schema, "reasonCode");
    const source = Object.freeze([...FINAL_REJECTION_REASONS].sort());
    expect(mirror).toEqual(source);
  });

  it("OrderTypingMissingInfoV1.reasonCode mirrors MISSING_INFO_REASONS", () => {
    const mirror = extractEnumValuesFromSchema(OrderTypingMissingInfoV1.schema, "reasonCode");
    const source = Object.freeze([...MISSING_INFO_REASONS].sort());
    expect(mirror).toEqual(source);
  });
});

// ---------------------------------------------------------------------------
// @pharmax/clinical-screening PV1 hints
// ---------------------------------------------------------------------------
//
// The screening engine cannot import `PV1_REJECTION_REASONS`: it sits
// BELOW the domain tier by design, so that any domain package may
// depend on it, and reaching up into `@pharmax/verification` would
// invert that. It therefore reproduces the handful of codes it
// suggests, and these tests are what keep the copy honest.
//
// How to recover when this fails: a code in `PV1_REJECTION_REASONS`
// was renamed or removed while a screening hint still points at it.
// Fix the hint in `packages/clinical-screening/src/findings.ts` — do
// NOT re-add the stale code here just to make the test pass.
//
// Unlike the event mirrors above this is a SUBSET relationship, not
// equality: screening only has an opinion about the clinical reasons
// it can compute, and has nothing to say about `SIG_AMBIGUOUS` or
// `INSURANCE_PRIOR_AUTH_REQUIRED`.

describe("clinical-screening PV1 hints are real @pharmax/verification reasons", () => {
  it("every published hint is a member of PV1_REJECTION_REASONS", () => {
    for (const hint of SUGGESTED_PV1_REJECTION_REASONS) {
      expect(PV1_REJECTION_REASONS).toContain(hint);
    }
  });

  it("every hint the engine can actually emit is a member", () => {
    // Asserted over the function's real output as well as the
    // published list, so a finding kind wired to a code that never
    // made it into that list is still caught.
    const emitted = SCREENING_FINDING_KINDS.map(suggestedPv1RejectionReason).filter(
      (reason) => reason !== null
    );
    expect(emitted.length).toBeGreaterThan(0);
    for (const hint of emitted) {
      expect(PV1_REJECTION_REASONS).toContain(hint);
    }
  });

  it("still covers the three clinical reasons screening exists to compute", () => {
    // Membership alone would still pass if a hint were dropped
    // altogether, leaving the console with nothing to preselect for
    // the findings this engine was built to produce.
    expect([...SUGGESTED_PV1_REJECTION_REASONS]).toEqual(
      expect.arrayContaining(["DRUG_INTERACTION", "ALLERGY_CONFLICT", "DUPLICATE_THERAPY"])
    );
  });
});
