# 0038 — PV1 requires zero acknowledgements in the default configuration

- **Status:** Accepted
- **Date:** 2026-08-11
- **Deciders:** Platform team, pharmacy ops lead
- **Tags:** `workflow`, `clinical-screening`, `safety`

## Context

Clinical screening runs inside PV1: `screenPrescription` grades every
finding with a severity and a certainty, and `dispositionFor` maps the
pair to `HARD_STOP`, `REQUIRES_ACKNOWLEDGEMENT`, or `INFORMATIONAL`.
Acknowledgement is the mechanism that forces a pharmacist to look at a
specific finding before approving.

The engine ships with **questions and no answers**: `DrugKnowledgeSource`
is an interface, and the only implementation in this repository is an
empty in-memory container, because interaction tables and severity
gradings are licensed proprietary content that a clean-room codebase
must not embed (ADR context in
`packages/verification/src/screening/configure.ts` and
`.cursor/rules/04-clean-room-policy.mdc`). A deployment without a
licensed source therefore cannot produce a clinical finding at all —
every drug lookup returns "no knowledge", and the engine emits a
`SCREENING_GAP` finding (`SCR_KNOWLEDGE_UNAVAILABLE`) on every
prescription.

Early in the screening work, that gap was graded so that it demanded a
per-order acknowledgement: the pharmacist attested, on every single
prescription, that the platform had not screened it. When the
remediation taxonomy landed (`screeningGapSeverity` in
`packages/clinical-screening/src/findings.ts`), systemic gaps —
`PLATFORM_CAPABILITY`, `ORGANIZATION_DATA`, `RECORD_IMMUTABLE` — were
regraded MINOR, whose disposition is `INFORMATIONAL`. Only
`SUBJECT_DATA` gaps (something _this patient's record_ is missing, e.g.
no allergy history taken) remain MODERATE and acknowledgement-gated.

The consequence, stated plainly: **a stock deployment's PV1 approval
path presents zero acknowledgements**. The control that used to force a
human attestation of "this was not screened" became a boot warning and
a coverage figure. That trade was made deliberately, but it was made in
code review rather than on the record; this ADR is the record.

## Decision

In the default configuration — no licensed `DrugKnowledgeSource` wired —
PV1 approval requires **zero acknowledgements**, and the systemic
inability to screen is carried by three non-interruptive surfaces
instead of a per-order attestation:

- **The finding stream.** Every prescription still persists a
  `SCREENING_GAP` finding to `order_screening_finding`, including its
  `remediation` column. An unconfigured deployment never _silently_
  approves an unscreened order; the record says on its face that no
  screening was performed.
- **The boot warning.** The entry point states once, at startup, that
  screening will report a gap on every prescription
  (`clinicalScreeningKnowledgeSourceIsConfigured`).
- **Coverage reporting.** "What fraction of orders could not be
  screened, and whose fault" is a direct query over
  `order_screening_finding.remediation` (`gapCount` in projections).

Per-subject gaps are **not** covered by this decision: a
`SUBJECT_DATA` gap (no allergy history recorded for this patient) is
something a pharmacist can actually fix from the queue, so it stays
MODERATE / `REQUIRES_ACKNOWLEDGEMENT`.

## Consequences

Easier:

- **The acknowledge tier keeps its meaning.** An acknowledgement
  appears only when a pharmacist can act on the finding. An alert on
  100% of orders that nobody can act on trains the reflex that
  dismisses the one that mattered — the alert-fatigue failure mode this
  decision exists to avoid.
- **PV1 stays functional without a licence.** Refusing to approve (or
  demanding a click per order) in an unprovisioned deployment would be
  read as a bug and routed around; an honest recorded gap is strictly
  better than a control that operators learn to defeat.

Harder / obligations taken on:

- **The deficiency is no longer in any pharmacist's face.** If the boot
  warning is ignored and nobody reads coverage reports, an organization
  could run unscreened for months with each individual order looking
  unremarkable. Detection therefore depends on ops surfaces, not the
  clinical workflow: coverage (gap fraction by remediation) must stay
  on the reporting path, and a deployment gaining or losing its
  knowledge source should be visible in that figure immediately.
- **Findings must keep flowing.** The zero-ack posture is safe only
  because the gap is still persisted per order. Any change that stops
  recording `SCR_KNOWLEDGE_UNAVAILABLE` (for instance, filtering gaps
  through `minimumReportedSeverity`, from which they are deliberately
  exempt) silently converts "not screened, recorded" into "not
  screened, invisible" and must be treated as a safety regression.
- **The empty source must never return empty knowledge.** "I have no
  record of this drug" and "this drug has no ingredients" are different
  claims; the second screens clear. The `DrugKnowledgeSource` contract
  forbids it and the in-memory implementation returns `null`.

## Alternatives Considered

- **Per-order acknowledgement of the systemic gap** (the original
  behaviour). Attractive because a human explicitly owns every
  unscreened approval. Rejected: no pharmacist can license a drug
  database from the PV1 queue, so the attestation was pharmacists
  signing off on a product backlog — pure alert fatigue with no
  decision it could change.
- **Refuse PV1 entirely when unconfigured** (the `@pharmax/shipping`
  posture for unregistered carriers). Attractive because it makes the
  deficiency impossible to ignore. Rejected: it would be interpreted as
  an outage and worked around, and the workaround (approving outside
  the system, or a hasty stub source) is strictly worse than an honest
  recorded gap.
- **A one-time per-organization attestation** ("we know this deployment
  does not screen") instead of the boot warning. Still attractive as a
  future enhancement; not chosen now because it needs a home in the
  org-onboarding flow that does not yet exist. Nothing in this ADR
  precludes adding it.

## References

- Code: `packages/verification/src/screening/configure.ts` (the seam
  and the default), `packages/clinical-screening/src/findings.ts`
  (`screeningGapSeverity`, `dispositionFor`),
  `packages/composition/src/configurators/clinical-screening-configurator.ts`
- Migrations: `prisma/migrations/20260813000000_screening_finding_remediation/`
  (the remediation column that makes coverage a direct query)
- Companion ADRs: `0007-command-bus-twenty-step-contract.md`,
  `0008-workflow-as-versioned-data.md`
- Policy: `.cursor/rules/04-clean-room-policy.mdc`,
  `docs/governance/public-sources-reference.md`
