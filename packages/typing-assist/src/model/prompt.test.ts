// The prompt builder is where PHI either does or does not leave the
// process, and where a disputed suggestion becomes reproducible. Tests
// pin both:
//
//   1. PHI tripwire: a sig carrying identifying text (a phone number, a
//      DOB) is OMITTED from the prompt and the omission is reported, so
//      "why did the model make no dose proposals?" has an answer on the
//      run row instead of being invisible.
//   2. Determinism: the input digest is stable across calls and moves
//      when any input moves — including when the sig is dropped by the
//      tripwire, which must not produce the same digest as a run that
//      genuinely had no sig recorded... and DOES, deliberately, since
//      both showed the model the same thing. That equality is asserted
//      so the choice is explicit rather than incidental.
//
// All data is synthetic. No PHI.

import { describe, expect, it } from "vitest";

import { buildTypingSuggestionPrompt } from "./prompt.js";
import type { TypingSuggestionPromptInput } from "./prompt.js";
import type { TypingDraft } from "../evaluate-typing-draft.js";

const draft: TypingDraft = {
  quantityAuthorized: 60,
  daysSupply: 30,
  refillsAuthorized: 2,
  refillsRemaining: 2,
  originalDateWritten: "2026-08-01",
  expiresAt: "2027-08-01",
  daw: 0,
  controlledSubstanceSchedule: "NON_CONTROLLED",
  earliestFillDate: null,
};

function input(overrides: Partial<TypingSuggestionPromptInput> = {}): TypingSuggestionPromptInput {
  return {
    draft,
    sigText: "Take 1 tablet by mouth twice daily",
    structuredSig: {
      sigStructureKind: "FIXED",
      doseAmount: 1,
      doseUnit: "TABLET",
      dosesPerDay: 2,
    },
    drug: {
      name: "Metformin",
      strength: "500 mg",
      form: "TABLET",
      catalogSchedule: "NON_CONTROLLED",
    },
    deterministicFindingCodes: [],
    ...overrides,
  };
}

describe("prompt builder — PHI tripwire on the sig", () => {
  it("includes a clean sig and reports no omission", () => {
    const built = buildTypingSuggestionPrompt(input());

    expect(built.sigOmitted).toBe(false);
    expect(built.request.user).toContain("Take 1 tablet by mouth twice daily");
  });

  it("omits a sig containing a phone number and says so in the prompt", () => {
    const built = buildTypingSuggestionPrompt(
      input({ sigText: "Take 1 tablet twice daily, call 555-867-5309 with questions" })
    );

    expect(built.sigOmitted).toBe(true);
    expect(built.request.user).not.toContain("555-867-5309");
    // The model must be told the sig is missing, or it will reason as
    // though the sig said nothing rather than that it was withheld.
    expect(built.request.user).toContain("Sig text withheld");
  });

  it("omits a sig carrying a labelled date of birth", () => {
    const built = buildTypingSuggestionPrompt(
      input({ sigText: "Take 1 tablet daily. DOB: 1980-01-02." })
    );

    expect(built.sigOmitted).toBe(true);
    expect(built.request.user).not.toContain("1980-01-02");
  });

  it("does NOT catch an unlabelled slash-format date — a known tripwire limit", () => {
    // Pinning the gap rather than implying coverage we don't have. The
    // tripwire's DOB rules require either a label ("DOB:") or an ISO
    // 19xx date, because a bare `\d\d/\d\d/\d{4}` rule in
    // @pharmax/platform-core would fire across every guarded surface it
    // protects. Sending this sig to the provider is permitted anyway —
    // Bedrock is inside the BAA with zero retention — so the tripwire
    // is defence in depth, not the control that makes the sig safe. If
    // this ever becomes the binding risk, the fix belongs in the shared
    // tripwire (with its false-positive budget re-examined), not in a
    // typing-assist-local regex.
    const built = buildTypingSuggestionPrompt(
      input({ sigText: "Take 1 tablet daily. Patient DOB 01/02/1980." })
    );

    expect(built.sigOmitted).toBe(false);
  });

  it("reports no omission when there was no sig to omit", () => {
    const built = buildTypingSuggestionPrompt(input({ sigText: null }));

    // `sigOmitted` means "the tripwire fired", not "no sig reached the
    // model" — conflating them would make the run row's tripwire signal
    // useless for spotting a data-entry problem.
    expect(built.sigOmitted).toBe(false);
    expect(built.request.user).toContain("Sig text withheld");
  });
});

describe("prompt builder — determinism", () => {
  it("produces an identical digest for identical inputs", () => {
    expect(buildTypingSuggestionPrompt(input()).inputDigestSha256).toBe(
      buildTypingSuggestionPrompt(input()).inputDigestSha256
    );
  });

  it("moves the digest when any draft field moves", () => {
    const base = buildTypingSuggestionPrompt(input()).inputDigestSha256;
    const moved = buildTypingSuggestionPrompt(
      input({ draft: { ...draft, quantityAuthorized: 90 } })
    ).inputDigestSha256;

    expect(moved).not.toBe(base);
  });

  it("is insensitive to the ORDER of deterministic finding codes", () => {
    // The codes are a set; a caller-side ordering difference must not
    // make two identical runs look like different inputs.
    const a = buildTypingSuggestionPrompt(
      input({ deterministicFindingCodes: ["TA_CII_WITH_REFILLS", "TA_DAW_OUT_OF_RANGE"] })
    ).inputDigestSha256;
    const b = buildTypingSuggestionPrompt(
      input({ deterministicFindingCodes: ["TA_DAW_OUT_OF_RANGE", "TA_CII_WITH_REFILLS"] })
    ).inputDigestSha256;

    expect(a).toBe(b);
  });

  it("digests what the model was SHOWN, so a tripwired sig matches a withheld one", () => {
    const tripwired = buildTypingSuggestionPrompt(
      input({ sigText: "Take 1 tablet daily, call 555-867-5309" })
    ).inputDigestSha256;
    const withheld = buildTypingSuggestionPrompt(input({ sigText: null })).inputDigestSha256;

    // The digest is evidence of the model's inputs, not of the row's
    // contents — so it must NOT be a channel through which the omitted
    // sig can be distinguished.
    expect(tripwired).toBe(withheld);
  });

  it("pins temperature at 0 and a bounded output length", () => {
    const built = buildTypingSuggestionPrompt(input());

    expect(built.request.temperature).toBe(0);
    expect(built.request.maxOutputTokens).toBeGreaterThan(0);
    expect(built.promptVersion).toBeGreaterThanOrEqual(1);
  });
});

describe("prompt builder — instructions", () => {
  it("names the allowed fields and forbids inventing others", () => {
    const built = buildTypingSuggestionPrompt(input());

    expect(built.request.user).toContain("quantityAuthorized");
    expect(built.request.user).toContain("Allowed fields:");
    expect(built.request.system).toContain("Never invent other fields");
  });

  it("tells the model an empty answer is acceptable", () => {
    // Without this, a model under instruction pressure invents
    // low-value proposals to look useful — which is how a review panel
    // trains technicians to click through it.
    expect(buildTypingSuggestionPrompt(input()).request.user).toContain(
      "empty suggestions array is a valid"
    );
  });

  it("lists already-flagged finding codes so proposals are not restated", () => {
    const built = buildTypingSuggestionPrompt(
      input({ deterministicFindingCodes: ["TA_CII_WITH_REFILLS"] })
    );

    expect(built.request.user).toContain("TA_CII_WITH_REFILLS");
    expect(built.request.user).toContain("do NOT restate");
  });
});
