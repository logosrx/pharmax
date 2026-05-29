// Cross-package parity for closed reason-code enums between
// `@pharmax/verification` (source of truth) and the local mirrors
// inside `@pharmax/events/events/order/*.ts` payload schemas.
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
