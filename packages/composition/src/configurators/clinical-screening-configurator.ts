// Clinical-screening Configurator.
//
// Injects the `DrugKnowledgeSource` that every PV1 screen resolves
// against. This is the seam that keeps a licensed drug database OUT of
// this repository: interaction tables, cross-sensitivity groupings and
// severity gradings are proprietary content, and embedding any of them
// — even a subset — is the access-plus-similarity pattern that
// forfeits a clean-room defence. The entry point supplies an adapter
// its customer's licence covers, exactly as it supplies a KMS adapter.
//
// Omitting `knowledgeSource` is a supported configuration, not a
// misconfiguration: the empty in-memory source makes the engine report
// `SCR_KNOWLEDGE_UNAVAILABLE` on every prescription, which requires a
// pharmacist acknowledgement before ApprovePV1 will pass. A deployment
// without a licensed source therefore says plainly that it could not
// screen, on every order, rather than implying a safety check it never
// performed.
//
// Priority: after the command bus, alongside the other domain-adapter
// wiring. No dispatch happens at boot, so the ordering is convention
// rather than a hard requirement — but a PV1 command arriving before
// this ran would screen against the empty source, and "wired late"
// should not be a way to silently lose screening coverage.

import { configureClinicalScreening } from "@pharmax/verification";

import { BUILT_IN_PRIORITIES } from "../priorities.js";
import type { ClinicalScreeningConfiguration, Configurator } from "../types.js";

export function createClinicalScreeningConfigurator(
  config: ClinicalScreeningConfiguration
): Configurator {
  return Object.freeze({
    name: "@pharmax/clinical-screening",
    priority: BUILT_IN_PRIORITIES.CLINICAL_SCREENING,
    apply(): void {
      configureClinicalScreening(config);
    },
  });
}
