// Prompt builder for the typing-suggestion model stage.
//
// Pure function: draft facts in, a versioned prompt out. No I/O, no
// clock, no randomness — the same inputs always produce the same
// prompt and the same input digest, so a disputed suggestion can be
// re-derived byte-for-byte from what the run row recorded.
//
// PHI posture (deliberately different from @pharmax/compliance-ai):
// the ONE free-text input is the prescription's sig, decrypted by the
// caller. It is sent because deriving structured dose fields from the
// sig is where a model earns its keep, and the provider sits inside
// the BAA boundary (Bedrock, zero retention). Patient identity,
// prescriber identity, and the encrypted note fields are not inputs —
// the input TYPE cannot carry them. Defense in depth: the sig is
// PHI-tripwire-scanned anyway; if a rule fires (a phone number or DOB
// pasted into sig text), the sig is OMITTED from the prompt and the
// run records `sigOmitted: true` rather than failing — structured
// checks still benefit from the model, and the tripwire hit is loud.

import { createHash } from "node:crypto";

import { phi } from "@pharmax/platform-core";

import type { ControlledSchedule, TypingDraft } from "../evaluate-typing-draft.js";
import { TYPING_SUGGESTION_FIELDS } from "../suggestions/fields.js";
import type { TypingModelRequest } from "./port.js";

/** Bumped whenever the template below changes meaning. */
export const TYPING_SUGGESTION_PROMPT_VERSION = 1;

export const TYPING_SUGGESTION_MAX_OUTPUT_TOKENS = 1200;

const SYSTEM_PREAMBLE = [
  "You are a prescription-transcription QA assistant inside a pharmacy",
  "operating system. A technician has typed a prescription from a source",
  "document; your job is to flag likely transcription errors in the",
  "STRUCTURED fields and propose corrected values.",
  "",
  "Hard rules:",
  "- Propose changes ONLY for the fields the user message lists as",
  "  allowed. Never invent other fields.",
  "- Never propose a diagnosis, a therapy change, or a different drug.",
  "  You are checking transcription, not prescribing.",
  "- Base every proposal strictly on the provided inputs. If the inputs",
  "  are insufficient to be confident, do not propose.",
  "- confidencePercent is an integer 0-100 and must reflect honest",
  "  uncertainty; a wrong high-confidence proposal is the worst outcome.",
  "- rationale must be one sentence, must reference only the provided",
  "  inputs, and must not repeat the sig text verbatim.",
  "- Respond with a single JSON object and nothing else.",
].join("\n");

export interface TypingSuggestionPromptInput {
  readonly draft: TypingDraft;
  /** Decrypted sig text, or null when unavailable. */
  readonly sigText: string | null;
  readonly structuredSig: {
    readonly sigStructureKind: string | null;
    readonly doseAmount: number | null;
    readonly doseUnit: string | null;
    readonly dosesPerDay: number | null;
  };
  readonly drug: {
    readonly name: string;
    readonly strength: string | null;
    readonly form: string | null;
    readonly catalogSchedule: ControlledSchedule;
  };
  /** Codes of deterministic findings already raised, so the model
   *  does not spend its proposals restating them. */
  readonly deterministicFindingCodes: ReadonlyArray<string>;
}

export interface BuiltTypingPrompt {
  readonly request: TypingModelRequest;
  readonly promptVersion: number;
  /** SHA-256 of the canonical input JSON — recorded on the run so a
   *  dispute can prove what the model was shown. */
  readonly inputDigestSha256: string;
  /** True when the PHI tripwire fired on the sig and it was omitted. */
  readonly sigOmitted: boolean;
}

/** Canonical JSON: keys sorted at every level, no whitespace. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildTypingSuggestionPrompt(input: TypingSuggestionPromptInput): BuiltTypingPrompt {
  // Tripwire the sig BEFORE it can reach the prompt. A hit does not
  // fail the run — the model still checks structured coherence — but
  // the omission is recorded so "why no dose suggestions?" has an
  // answer in the run row.
  const sigHits = input.sigText === null ? [] : phi.scanForPhi(input.sigText);
  const sigOmitted = input.sigText !== null && sigHits.length > 0;
  const sigForPrompt = sigOmitted ? null : input.sigText;

  const { draft, structuredSig, drug } = input;

  const canonicalInput = canonicalize({
    promptVersion: TYPING_SUGGESTION_PROMPT_VERSION,
    draft,
    sigText: sigForPrompt,
    structuredSig,
    drug,
    deterministicFindingCodes: [...input.deterministicFindingCodes].sort(),
  });

  const user = [
    "Review this typed prescription draft for transcription errors.",
    "",
    `Drug (catalog): ${drug.name}` +
      (drug.strength !== null ? ` ${drug.strength}` : "") +
      (drug.form !== null ? ` (${drug.form})` : "") +
      `, DEA schedule ${drug.catalogSchedule}`,
    "",
    "Typed structured fields:",
    `- quantityAuthorized: ${draft.quantityAuthorized}`,
    `- daysSupply: ${draft.daysSupply}`,
    `- refillsAuthorized: ${draft.refillsAuthorized}`,
    `- refillsRemaining: ${draft.refillsRemaining}`,
    `- daw: ${draft.daw}`,
    `- originalDateWritten: ${draft.originalDateWritten}`,
    `- expiresAt: ${draft.expiresAt}`,
    `- earliestFillDate: ${draft.earliestFillDate ?? "(none)"}`,
    `- controlledSubstanceSchedule: ${draft.controlledSubstanceSchedule}`,
    `- sigStructureKind: ${structuredSig.sigStructureKind ?? "(not derived)"}`,
    `- doseAmount: ${structuredSig.doseAmount ?? "(not derived)"}`,
    `- doseUnit: ${structuredSig.doseUnit ?? "(not derived)"}`,
    `- dosesPerDay: ${structuredSig.dosesPerDay ?? "(not derived)"}`,
    "",
    sigForPrompt !== null
      ? `Sig as typed: ${sigForPrompt}`
      : "Sig text withheld — reason strictly with the structured fields above.",
    "",
    "Deterministic validators already flagged these codes (do NOT restate them): " +
      (input.deterministicFindingCodes.length > 0
        ? [...input.deterministicFindingCodes].sort().join(", ")
        : "(none)"),
    "",
    "Typical checks: does the sig's dose arithmetic agree with",
    "quantityAuthorized × daysSupply; do the structured dose fields",
    "(doseAmount / doseUnit / dosesPerDay / sigStructureKind) match the",
    "sig; is the quantity plausible for the drug form; is expiresAt a",
    "plausible validity window for the written date and schedule.",
    "",
    `Allowed fields: ${TYPING_SUGGESTION_FIELDS.join(", ")}`,
    "",
    'Respond as JSON: {"suggestions": [{"field": string, "proposedValue":',
    'string | number | null, "rationale": string, "confidencePercent":',
    "integer 0-100}]} — an empty suggestions array is a valid and common",
    "answer.",
  ].join("\n");

  return {
    request: {
      system: SYSTEM_PREAMBLE,
      user,
      maxOutputTokens: TYPING_SUGGESTION_MAX_OUTPUT_TOKENS,
      temperature: 0,
    },
    promptVersion: TYPING_SUGGESTION_PROMPT_VERSION,
    inputDigestSha256: createHash("sha256").update(canonicalInput, "utf8").digest("hex"),
    sigOmitted,
  };
}
