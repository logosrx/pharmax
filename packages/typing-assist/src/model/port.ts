// Provider boundary for the typing-suggestion model stage.
//
// Mirrors `ComplianceModelPort` (@pharmax/compliance-ai) rather than
// importing it: the two packages are sibling domains with different
// PHI postures — compliance prompts must be PHI-free, typing prompts
// may carry the decrypted sig text because the provider sits inside
// the BAA boundary (AWS Bedrock, zero retention). Sharing a type
// across that difference would blur the one property each package
// most needs to keep locally auditable.
//
// One method, no state, no writes. The Bedrock adapter lives in
// apps/worker (where AWS SDK clients and env config already live);
// every test in this package runs against a stub.

export interface TypingModelRequest {
  readonly system: string;
  readonly user: string;
  /** Hard ceiling on response length — a runaway generation costs a
   *  bounded amount. */
  readonly maxOutputTokens: number;
  /** Always 0 from this package: we want the most probable reading of
   *  a prescription draft, and re-runs must be comparable when a
   *  suggestion is disputed. */
  readonly temperature: number;
}

export interface TypingModelResponse {
  /** Raw text. Parsing and validation happen in this package. */
  readonly text: string;
  /** Provider-reported model identifier, recorded on the run. */
  readonly modelId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface TypingModelPort {
  /** Provider tag recorded on the run ("bedrock"). */
  readonly provider: string;
  complete: (request: TypingModelRequest) => Promise<TypingModelResponse>;
}
