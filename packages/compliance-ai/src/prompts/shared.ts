// Shared prompt scaffolding.
//
// The system preamble is common to every kind because the constraints
// it states are properties of this layer, not of any one task. Two of
// them are load-bearing:
//
//   "Say you do not know" — the failure mode for a compliance drafting
//   model is not refusing; it is confabulating a plausible control
//   description for something that was never built. A draft that
//   claims quarterly access reviews happen, accepted by a reviewer
//   skimming for tone, is a false statement in the auditor's file with
//   a human's name on it.
//
//   "Describe only what the inputs state" — the model has broad prior
//   knowledge of what a SOC 2 program usually contains, and that prior
//   is exactly what makes its inventions convincing.

import { createHash } from "node:crypto";

import { canonicalStringify } from "@pharmax/command-bus";

import { assertNoPhi } from "../guards/phi-tripwire.js";
import type { BuiltPrompt, ModelRequest } from "../types.js";

/**
 * Shared system preamble. Changing this text is a prompt-version bump
 * on every kind, since it changes what every draft was told.
 */
export const SYSTEM_PREAMBLE = [
  "You draft text for a pharmacy platform's SOC 2 and HIPAA compliance program.",
  "",
  "Rules:",
  "- Describe ONLY what the supplied inputs state. Do not add controls, evidence,",
  "  cadences, or tooling that the inputs do not mention, even when they would be",
  "  typical for a program like this one.",
  "- If the inputs are insufficient to answer, say so plainly in the designated",
  "  field and leave the draft minimal. An incomplete draft is useful; an invented",
  "  one is a false statement in an audit file.",
  "- Never assert that something is tested, monitored, reviewed, or encrypted",
  "  unless an input says it is.",
  "- Write plainly and specifically. No marketing language, no hedging filler.",
  "- Your output is a PROPOSAL. A named human reviews and accepts or rejects it",
  "  before it becomes part of the record. Nothing you write takes effect directly.",
  "- Respond with a single JSON object matching the requested shape and nothing",
  "  else. No prose before or after, no code fences.",
].join("\n");

/**
 * Canonical JSON of the structured prompt inputs, plus its digest.
 *
 * Reuses the command bus's `canonicalStringify` so a compliance
 * prompt digest is computed exactly like an idempotency-key hash —
 * key order cannot change the digest, which is what lets a reviewer
 * confirm two drafts came from identical inputs.
 */
export function canonicalizeInputs(inputs: unknown): {
  readonly canonical: string;
  readonly digest: string;
} {
  const canonical = canonicalStringify(inputs);
  return {
    canonical,
    digest: createHash("sha256").update(canonical).digest("hex"),
  };
}

/**
 * Final assembly step for every draft kind.
 *
 * The tripwire runs here rather than in the provider adapter because
 * this is the one place all prompt text passes through, and it is in
 * the same package as the builders whose inputs it constrains. An
 * adapter-side check would be one `complete()` call away from being
 * bypassed by a second adapter; a check here fires before a request
 * object exists to send.
 *
 * `inputSummary` is scanned too. It is persisted on the draft row and
 * rendered in review, so it is an egress path in its own right.
 */
export function finalizePrompt(args: {
  readonly request: ModelRequest;
  readonly promptVersion: number;
  readonly inputSummary: string;
  readonly inputCanonical: string;
  /** Draft kind, for the refusal message. */
  readonly context: string;
}): BuiltPrompt {
  assertNoPhi(args.request.user, `${args.context} prompt`);
  assertNoPhi(args.inputSummary, `${args.context} input summary`);

  return {
    request: args.request,
    promptVersion: args.promptVersion,
    inputSummary: args.inputSummary,
    inputCanonical: args.inputCanonical,
  };
}

/**
 * Strip a model's response down to the JSON object it should have
 * been.
 *
 * Models append explanations and wrap output in code fences despite
 * instructions not to. Recovering from that here is not leniency
 * about correctness — the result is still validated against the
 * kind's Zod schema — it just avoids discarding a good draft over
 * three backticks.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();

  // Fall back to the outermost brace pair when the model wrapped the
  // object in prose.
  if (!body.startsWith("{")) {
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first !== -1 && last > first) return body.slice(first, last + 1);
  }
  return body;
}
