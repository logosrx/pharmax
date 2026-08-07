// The reviewed-screen digest is an attestation format: the console
// computes it over a rendered findings list, the approve form carries
// it, and `ApprovePV1` recomputes it over the sign-off screen. Both
// sides must therefore agree on the value for the SAME list however
// it is ordered or duplicated — and disagree for any different list.
// These tests pin that contract; the command-level consequences (the
// committed refusal) are asserted in `approve-pv1.test.ts`.

import { describe, expect, it } from "vitest";

import type { ScreeningEvaluation } from "@pharmax/clinical-screening";

import { PV1_SCREENING_CHANGED_SINCE_REVIEW } from "./errors.js";
import {
  SCREEN_DIGEST_PATTERN,
  screenChangedSinceReviewRefusal,
  screenedFindingsDigest,
} from "./digest.js";

const FP_A = "SCR_DRUG_INTERACTION|MAJOR/PROBABLE|INGREDIENT_ALFA+INGREDIENT_BRAVO";
const FP_B =
  "SCR_KNOWLEDGE_UNAVAILABLE|MINOR/DEFINITE|00000-0000-01|remediation=PLATFORM_CAPABILITY;scope=CANDIDATE_DRUG";
const FP_C = "SCR_DOSE_INPUT_UNAVAILABLE|MINOR/DEFINITE|DOSE_RANGE|remediation=RECORD_IMMUTABLE";

function evaluationWith(fingerprints: ReadonlyArray<string>): ScreeningEvaluation {
  // The refusal helper reads nothing but `findings[].fingerprint`;
  // narrowing the fixture to that keeps the test honest about the
  // dependency (a helper that starts reading more will fail to
  // compile here until the fixture says what it reads).
  return {
    findings: fingerprints.map((fingerprint) => ({ fingerprint })),
  } as unknown as ScreeningEvaluation;
}

describe("screenedFindingsDigest", () => {
  it("is deterministic and shaped like the pattern the route validates", () => {
    const digest = screenedFindingsDigest([FP_A, FP_B]);
    expect(digest).toBe(screenedFindingsDigest([FP_A, FP_B]));
    expect(digest).toMatch(SCREEN_DIGEST_PATTERN);
  });

  it("is order-insensitive — the panel sorts for the reader, the engine for the gate", () => {
    expect(screenedFindingsDigest([FP_A, FP_B, FP_C])).toBe(
      screenedFindingsDigest([FP_C, FP_A, FP_B])
    );
  });

  it("is duplicate-insensitive — a fingerprint is an identity, not a count", () => {
    expect(screenedFindingsDigest([FP_A, FP_A, FP_B])).toBe(screenedFindingsDigest([FP_A, FP_B]));
  });

  it("digests the empty list — a clean screen is an attestation too", () => {
    expect(screenedFindingsDigest([])).toMatch(SCREEN_DIGEST_PATTERN);
    expect(screenedFindingsDigest([])).not.toBe(screenedFindingsDigest([FP_A]));
  });

  it("distinguishes every different list, in both directions", () => {
    // Added, removed, and swapped — the three ways a screen moves
    // under a review.
    expect(screenedFindingsDigest([FP_A])).not.toBe(screenedFindingsDigest([FP_A, FP_B]));
    expect(screenedFindingsDigest([FP_A, FP_B])).not.toBe(screenedFindingsDigest([FP_A]));
    expect(screenedFindingsDigest([FP_A])).not.toBe(screenedFindingsDigest([FP_B]));
  });

  it("does not confuse concatenation boundaries", () => {
    // Two fingerprints that concatenate to the same string must not
    // collide: the digest separates entries, not just joins them.
    expect(screenedFindingsDigest(["AB", "C"])).not.toBe(screenedFindingsDigest(["A", "BC"]));
  });
});

describe("screenChangedSinceReviewRefusal", () => {
  it("passes when no digest was asserted — the queue's one-click approve", () => {
    expect(screenChangedSinceReviewRefusal(undefined, evaluationWith([FP_A]))).toBeNull();
  });

  it("passes when the sign-off screen digests to the reviewed value", () => {
    const reviewed = screenedFindingsDigest([FP_A, FP_B]);
    expect(screenChangedSinceReviewRefusal(reviewed, evaluationWith([FP_B, FP_A]))).toBeNull();
  });

  it("refuses any difference, and says which two digests disagreed without leaking findings", () => {
    const reviewed = screenedFindingsDigest([FP_A]);
    const refusal = screenChangedSinceReviewRefusal(reviewed, evaluationWith([FP_A, FP_B]));
    expect(refusal).not.toBeNull();
    expect(refusal).toMatchObject({
      code: PV1_SCREENING_CHANGED_SINCE_REVIEW,
      httpStatus: 422,
    });
    const metadata = (refusal as unknown as { metadata: Record<string, unknown> }).metadata;
    expect(metadata["reviewedScreenDigest"]).toBe(reviewed);
    expect(metadata["signOffDigest"]).toBe(screenedFindingsDigest([FP_A, FP_B]));
    expect(metadata["signOffFindingCount"]).toBe(2);
    // Digests and a count only — fingerprints carry finding codes,
    // and an error's metadata reaches logs and partner responses.
    expect(JSON.stringify(metadata)).not.toContain("SCR_");
  });

  it("refuses a vanished finding too — the gates would wave that through", () => {
    const reviewed = screenedFindingsDigest([FP_A, FP_B]);
    const refusal = screenChangedSinceReviewRefusal(reviewed, evaluationWith([FP_A]));
    expect(refusal).toMatchObject({ code: PV1_SCREENING_CHANGED_SINCE_REVIEW });
  });
});
