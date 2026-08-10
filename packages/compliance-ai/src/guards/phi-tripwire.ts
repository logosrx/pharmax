// PHI tripwire — last check before any text leaves for a model
// provider.
//
// The detector (pattern rules, `scanForPhi`) lives in
// `@pharmax/platform-core`'s `phi` module, shared with the other
// boundaries that must refuse PHI-shaped free text — notably the
// break-glass ledger gate in @pharmax/security. This module owns only
// what is specific to THIS boundary: the error code and the refusal
// wording, which names the model-provider stakes.
//
// Why the tripwire exists at all, what it is not, and the fail-closed
// rationale are documented on the shared module. The short version:
// it is not a PHI detector — it is a loud runtime refusal for the
// recognizable shapes of the realistic accident (someone widening a
// prompt builder to include operational data). The real control
// remains structural: prompt inputs are assembled by builders in this
// package that read only the compliance plane, and no probe or
// control record contains a patient column. A false positive blocks a
// policy paragraph from being drafted, which costs someone five
// minutes. A false negative sends patient data to a vendor with no
// BAA covering it, which is a reportable breach.

import { phi } from "@pharmax/platform-core";

/** Thrown when a prompt looks like it carries patient data. */
export const COMPLIANCE_AI_PHI_TRIPWIRE = "COMPLIANCE_AI_PHI_TRIPWIRE";

export type TripwireHit = phi.TripwireHit;

/** Report every rule that fires. Does not throw. */
export function scanForPhi(text: string): readonly TripwireHit[] {
  return phi.scanForPhi(text);
}

/**
 * Refuse the call if anything fires.
 *
 * The thrown error names the rules but never quotes the matched text:
 * an error message is logged, and logging the thing we just decided
 * was too sensitive to send would defeat the point.
 */
export function assertNoPhi(text: string, context: string): void {
  const hits = scanForPhi(text);
  if (hits.length === 0) return;

  throw new Error(
    `${COMPLIANCE_AI_PHI_TRIPWIRE}: refusing to send "${context}" to a model provider. ` +
      `Matched ${hits.length} rule(s): ${hits.map((h) => h.rule).join(", ")}. ` +
      `${hits.map((h) => h.explanation).join(" ")} ` +
      `Prompt inputs for this layer must come from the compliance plane only — control ` +
      `metadata, probe output, framework codes. If this is a false positive, narrow the ` +
      `input rather than widening the rule.`
  );
}
