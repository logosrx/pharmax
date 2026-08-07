// The reviewed-screen digest: how an approval names the findings list
// it was decided against.
//
// THE HOLE THIS CLOSES. `ApprovePV1` re-screens at sign-off and gates
// on the fresh result, so a hard stop or an unacknowledged finding
// that appears mid-review is caught. But the gate only inspects
// findings that DEMAND something — a finding that appears between
// render and sign-off with an INFORMATIONAL disposition, or a finding
// that silently disappears, changes nothing the gate checks, and the
// approval sails through bound to a list the pharmacist never saw.
// The digest closes that: the console computes it over the findings
// panel it actually rendered, the approve form carries it, and the
// command refuses when the sign-off screen's digest differs — for ANY
// difference, not just the ones the gate polices.
//
// SHAPE. SHA-256 (hex) over a version line plus the sorted, deduplicated
// finding fingerprints, one per line. Fingerprints are the identity
// the whole screening surface already keys on (acknowledgements,
// refusal metadata, panel rows), and they are PHI-free by
// construction — codes, severities and trigger codes only — so the
// digest is safe in a hidden form field, an error payload, or a log.
// Sorting makes it order-insensitive: the panel sorts by severity for
// the reader, the engine sorts for the gate, and neither ordering is
// part of what the pharmacist attested to.
//
// The `v1` line is the same convention `patient-scope.ts` uses for
// `recordStateToken`: if the inputs ever change shape, bump it so
// every in-flight form goes stale at once (a refused approval and a
// re-review — the safe direction) rather than colliding with digests
// of the old shape.

import { createHash } from "node:crypto";

import { errors } from "@pharmax/platform-core";
import type { ScreeningEvaluation } from "@pharmax/clinical-screening";

import { PV1_SCREENING_CHANGED_SINCE_REVIEW } from "./errors.js";

/** Hex SHA-256 — what the route accepts and the command compares. */
export const SCREEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Digest of a findings list, computed from its fingerprints.
 *
 * Deterministic, order-insensitive, duplicate-insensitive. The empty
 * list digests too: "I reviewed a clean screen" is as much an
 * attestation as any other.
 */
export function screenedFindingsDigest(fingerprints: Iterable<string>): string {
  const sorted = [...new Set(fingerprints)].sort();
  const hash = createHash("sha256");
  hash.update("v1\n");
  for (const fingerprint of sorted) {
    hash.update(fingerprint);
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * The digest gate `ApprovePV1` runs BEFORE the acknowledgement gate.
 *
 * Returns `null` when no digest was asserted (the queue's one-click
 * approve, and any API caller that has not adopted the assertion) or
 * when the asserted digest matches the sign-off screen. Returns the
 * refusal to raise when they differ.
 *
 * Runs before `screeningRefusalForApproval` deliberately: a stale
 * review voids the approval's premise regardless of what the gate
 * would say about the new list. The pharmacist's next move is the
 * same in every mismatch case — reload and re-review — and the panel
 * they reload shows the sign-off screen this refusal just persisted.
 *
 * Class: `InvariantViolationError` (422), same as the other
 * screening refusals — well-formed request, business rule said no,
 * retrying unchanged fails identically.
 */
export function screenChangedSinceReviewRefusal(
  reviewedScreenDigest: string | undefined,
  evaluation: ScreeningEvaluation
): errors.PharmaxError | null {
  if (reviewedScreenDigest === undefined) return null;
  const signOffDigest = screenedFindingsDigest(evaluation.findings.map((f) => f.fingerprint));
  if (signOffDigest === reviewedScreenDigest) return null;
  return new errors.InvariantViolationError({
    code: PV1_SCREENING_CHANGED_SINCE_REVIEW,
    message:
      "The screen at sign-off does not match the findings list this approval was reviewed against. " +
      "Nothing was approved. The sign-off screen has been recorded on the order — reload it and review the findings it shows now.",
    metadata: {
      // Digests only — PHI-free by construction, and enough for an
      // escalation to prove which rendered list a form was holding.
      reviewedScreenDigest,
      signOffDigest,
      signOffFindingCount: evaluation.findings.length,
    },
  });
}
