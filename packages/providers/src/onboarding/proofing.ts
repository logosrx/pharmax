// Automated NPPES identity-proofing evaluation (ADR-0033).
//
// Pure functions only — the worker drain fetches the CMS record via
// `CmsNppesClient` and hands it here; the verdict is dispatched to
// `RecordProviderOnboardingProofing`. Keeping the match rules pure
// makes the PASS bar unit-testable without any HTTP or DB fake.
//
// The PASS bar (per ADR-0033):
//   1. the NPI exists at CMS,
//   2. it is an NPI-1 (individual prescriber, not an organization),
//   3. CMS status is "A" (active),
//   4. the applicant's claimed last name matches the registry
//      record after normalization.
//
// Everything else routes to NEEDS_REVIEW — the system never
// hard-rejects on registry data alone.

import type { CmsNpiSnapshot } from "../npi-sync/diff-engine.js";

/** Mirrors the Prisma `ProviderOnboardingProofingOutcome` enum. */
export type ProofingOutcome =
  | "PASS"
  | "NOT_FOUND"
  | "NOT_INDIVIDUAL"
  | "DEACTIVATED"
  | "NAME_MISMATCH"
  | "ALREADY_REGISTERED"
  | "REGISTRY_UNAVAILABLE";

export interface ProofingClaim {
  /** Applicant-claimed last name, as submitted. */
  readonly lastName: string;
}

/**
 * Normalize a surname for matching: case-fold, strip accents,
 * drop punctuation (apostrophes, hyphens, periods), collapse
 * whitespace. "O'Brien-Smith" and "OBRIEN SMITH" both normalize to
 * "obriensmith" — NPPES data entry is inconsistent about
 * punctuation, and a false NEEDS_REVIEW on every O'Connor is worse
 * than the marginal looseness.
 */
export function normalizeSurname(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Evaluate the claim against the fetched registry record.
 * `snapshot === null` means CMS returned no record for the NPI.
 *
 * ALREADY_REGISTERED and REGISTRY_UNAVAILABLE are not produced
 * here — the former is a roster check inside the command's
 * transaction; the latter is the drain's retry-ceiling verdict.
 */
export function evaluateProofing(
  claim: ProofingClaim,
  snapshot: CmsNpiSnapshot | null
): Exclude<ProofingOutcome, "ALREADY_REGISTERED" | "REGISTRY_UNAVAILABLE"> {
  if (snapshot === null) return "NOT_FOUND";
  if (snapshot.enumerationType !== "NPI-1") return "NOT_INDIVIDUAL";
  if (snapshot.status !== "A") return "DEACTIVATED";
  if (
    snapshot.lastName === null ||
    normalizeSurname(snapshot.lastName) !== normalizeSurname(claim.lastName)
  ) {
    return "NAME_MISMATCH";
  }
  return "PASS";
}

/**
 * Serialize the registry record into the JSON evidence blob stored
 * on the application row. Public NPPES data only — PHI-free by
 * construction. Dates become ISO strings so the blob round-trips
 * through Prisma `Json` losslessly.
 */
export function buildProofingSnapshotJson(snapshot: CmsNpiSnapshot): Record<string, unknown> {
  return {
    npi: snapshot.npi,
    enumerationType: snapshot.enumerationType,
    status: snapshot.status,
    firstName: snapshot.firstName,
    lastName: snapshot.lastName,
    credential: snapshot.credential,
    lastUpdatedAtCms: snapshot.lastUpdatedAtCms.toISOString(),
  };
}
