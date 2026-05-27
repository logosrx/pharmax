// Document classification — the structural input that drives every
// PHI-handling decision the storage layer makes.
//
// The four levels are a hard, closed enum. There is no "MIXED" or
// "UNKNOWN"; callers must pick. A bug that defaults to PHI is
// strictly preferable to a bug that defaults to PUBLIC, so the
// type system forces every `put` site to make the call explicitly.
//
// Levels:
//
//   - PHI:          Protected Health Information per HIPAA. Examples:
//                   prescription images, lab results, signed patient
//                   consent forms. MUST be encrypted at rest with an
//                   AAD binding to its record context, MUST go to a
//                   HIPAA-eligible bucket, MUST NEVER appear in logs.
//   - CONFIDENTIAL: Internal-only business data that is sensitive but
//                   not PHI. Examples: clinic contracts, pricing
//                   sheets, signed business agreements, generated
//                   invoice PDFs that include line items but no
//                   patient identifiers. Encrypted at rest;
//                   access-controlled but no AAD binding required.
//   - INTERNAL:     Pharmax operations material that doesn't leave the
//                   organization. Examples: SOPs, internal training
//                   documents, generated operational reports.
//                   No encryption required at rest beyond bucket-level
//                   defaults.
//   - PUBLIC:       Material the public is allowed to see. Examples:
//                   the marketing-site press kit, the public terms-of-
//                   service PDF. Cacheable, no auth gate.
//
// The level is recorded on every stored document and is read back on
// `get` / `signUrl`. The storage adapter uses the level to:
//
//   1. Decide whether to require an AAD binding (PHI only).
//   2. Decide which bucket / KMS key to use (production adapters).
//   3. Decide signed-URL TTL ceilings (PHI gets the shortest).
//   4. Decide whether to log the document id at all (PHI gets a
//      hash; CONFIDENTIAL gets the id; INTERNAL / PUBLIC log freely).

export const DOCUMENT_CLASSIFICATIONS = ["PHI", "CONFIDENTIAL", "INTERNAL", "PUBLIC"] as const;

export type DocumentClassification = (typeof DOCUMENT_CLASSIFICATIONS)[number];

/** Type guard for narrowing untrusted input. */
export function isDocumentClassification(value: unknown): value is DocumentClassification {
  return (
    typeof value === "string" && (DOCUMENT_CLASSIFICATIONS as ReadonlyArray<string>).includes(value)
  );
}

/** PHI is the only level that REQUIRES an AAD binding at `put`
 *  time. The port reads this single source of truth so a new
 *  level in the future (e.g. `PHI_RESTRICTED` for genomic data)
 *  only flips a switch here. */
export function requiresAadBinding(classification: DocumentClassification): boolean {
  return classification === "PHI";
}

/** Maximum allowed signed-URL TTL per classification, in seconds.
 *  PHI gets the shortest window (5 minutes); CONFIDENTIAL gets 15
 *  minutes; INTERNAL gets an hour; PUBLIC gets a day. Adapters
 *  enforce; this is the rule. */
export function maxSignedUrlTtlSeconds(classification: DocumentClassification): number {
  switch (classification) {
    case "PHI":
      return 5 * 60;
    case "CONFIDENTIAL":
      return 15 * 60;
    case "INTERNAL":
      return 60 * 60;
    case "PUBLIC":
      return 24 * 60 * 60;
  }
}
