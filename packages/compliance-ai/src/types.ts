// Contracts for the compliance AI advisory layer.
//
// The single rule this package exists to enforce: a model may
// propose, and only a human may accept. Everything below is shaped to
// make the unsafe version hard to write by accident.
//
// Three decisions carry that rule:
//
//   1. The port returns TEXT. It has no access to Prisma, no command
//      bus, and no write capability of any kind. A model response
//      cannot become a database row without passing through a
//      human-dispatched command, because there is no code path from
//      here to a write. This is why the port is defined in terms of
//      strings rather than "apply this change" callbacks — a
//      tool-calling interface with write tools would put the entire
//      guarantee at the mercy of prompt injection.
//
//   2. Draft kinds are a closed union with a schema each. An
//      open-ended "ask the model about compliance" surface would put
//      unvalidated prose into the same table an auditor reads as
//      reviewed evidence.
//
//   3. Prompt inputs are assembled by builders in this package from
//      compliance-plane data only, and every prompt passes the PHI
//      tripwire before egress. The model vendor holds no BAA for
//      patient data. "The prompt only contains control metadata" is
//      an invariant that has to be enforced at runtime, not just
//      intended, because the thing that breaks it is a future caller
//      who passes an order id "for context".

import type { z } from "zod";

/** Mirrors the Prisma `ComplianceAiDraftKind` enum. */
export type ComplianceAiDraftKind =
  "CONTROL_DESCRIPTION" | "CRITERION_MAPPING" | "REMEDIATION_PLAN";

/** Mirrors the Prisma `ComplianceAiDraftStatus` enum. */
export type ComplianceAiDraftStatus =
  "PENDING" | "ACCEPTED" | "REJECTED" | "SUPERSEDED" | "EXPIRED";

/**
 * One model invocation.
 *
 * `system` and `user` are separated so the adapter can map them onto
 * whatever the provider's API calls them. Deliberately no `tools`
 * field: see decision (1).
 */
export interface ModelRequest {
  readonly system: string;
  readonly user: string;
  /**
   * Hard ceiling on response length. Present so a runaway generation
   * costs a bounded amount rather than an unbounded one.
   */
  readonly maxOutputTokens: number;
  /**
   * Sampling temperature. Callers here pass 0: this layer wants the
   * most probable reading of a policy document, not a creative one,
   * and a deterministic-ish setting makes a re-run comparable to the
   * original when someone disputes a draft.
   */
  readonly temperature: number;
}

export interface ModelResponse {
  /** Raw text. Parsing and validation happen in this package. */
  readonly text: string;
  /** Provider-reported model identifier, recorded on the draft. */
  readonly modelId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * Provider boundary.
 *
 * One method, no state, no writes. Bedrock is the current
 * implementation; the interface exists so that swapping providers is
 * an adapter change rather than a rewrite, and so that every test in
 * this package runs against a stub instead of a network call.
 */
export interface ComplianceModelPort {
  /** Provider tag recorded on the draft ("bedrock"). */
  readonly provider: string;
  complete: (request: ModelRequest) => Promise<ModelResponse>;
}

/**
 * A prompt built and ready to send, plus what has to be recorded
 * about it for the draft to be auditable.
 */
export interface BuiltPrompt {
  readonly request: ModelRequest;
  /** Bumped whenever the template changes. */
  readonly promptVersion: number;
  /** PHI-free one-liner describing the inputs. */
  readonly inputSummary: string;
  /** Canonical JSON of the structured inputs, for the digest. */
  readonly inputCanonical: string;
}

/**
 * Everything one draft kind needs: how to build its prompt, and what
 * shape its answer must take.
 *
 * Holding the schema next to the builder is what makes "the model
 * returned something we did not ask for" a parse failure rather than
 * a surprise in the review UI.
 */
export interface DraftKindDefinition<TInput, TOutput> {
  readonly kind: ComplianceAiDraftKind;
  readonly promptVersion: number;
  readonly maxOutputTokens: number;
  readonly build: (input: TInput) => BuiltPrompt;
  readonly outputSchema: z.ZodType<TOutput>;
}
