# Pharmax SOC 2 evidence framework

This directory holds the framework Pharmax uses to demonstrate operating
effectiveness of its controls to a SOC 2 auditor (and, by extension,
HIPAA assessors and customer-procurement security reviewers).

The directory is **the framework**, not the audit itself. Specifically:

- It does **not** commit Pharmax to a particular auditor or to a Type I
  or Type II report. Those decisions belong to leadership and the
  retained CPA firm.
- It does **not** replace the engineering artifacts that constitute the
  controls themselves. Those live in [`../adr/`](../adr/),
  [`../policies/`](../policies/), [`../governance/`](../governance/),
  [`../security/`](../security/), [`../compliance/`](../compliance/),
  and [`../operations/`](../operations/).
- It does **not** authorize anyone to publish a SOC 2 report. A SOC 2
  report is issued by a CPA firm; this framework gives that firm a
  navigable starting point and a working evidence pipeline.

What it _does_:

- Maps every Trust Service Criterion Pharmax claims to operate against
  to a specific Pharmax control, the implementation location, the
  evidence source, the cadence, and the owner. See
  [`trust-service-criteria-mapping.md`](./trust-service-criteria-mapping.md).
- Provides an inventory of every control with status flags (see
  [`controls-inventory.md`](./controls-inventory.md)) and every
  evidence artifact with its source (see
  [`evidence-inventory.md`](./evidence-inventory.md)).
- Provides operator playbooks for the recurring control activities
  (quarterly access review, change-management review, vendor risk
  review, incident response, data-classification review, annual policy
  review) under [`playbooks/`](./playbooks/).
- Provides a pre-audit readiness checklist (see
  [`audit-readiness-checklist.md`](./audit-readiness-checklist.md)).
- Provides stubs for the formal policies an auditor will read alongside
  the controls (see [`policies/`](./policies/)). These stubs are
  **explicitly not authoritative** — see
  [`policies/README.md`](./policies/README.md).
- Pairs with [`scripts/soc2/`](../../scripts/soc2/), which is the
  evidence-collection automation. Every periodic control in the TSC
  mapping is regenerable from one or more of those scripts.

## How the framework is organized

```
docs/soc2/
├── README.md                                # this file
├── trust-service-criteria-mapping.md        # centerpiece: TSC → controls → evidence
├── controls-inventory.md                    # control catalog with status
├── evidence-inventory.md                    # artifact catalog with source
├── playbooks/                               # operator instructions
│   ├── quarterly-access-review.md
│   ├── change-management-review.md
│   ├── vendor-risk-review.md
│   ├── incident-response.md
│   ├── data-classification-review.md
│   └── annual-policy-review.md
├── policies/                                # STUBS — legal review required
│   ├── README.md
│   ├── information-security.md
│   ├── access-control.md
│   ├── change-management.md
│   ├── incident-response.md
│   ├── data-classification.md
│   ├── backup-and-recovery.md
│   ├── vendor-management.md
│   ├── acceptable-use.md
│   └── business-continuity.md
└── audit-readiness-checklist.md             # ordered pre-audit list
```

## Ownership

The framework is jointly owned:

- **CTO** — accountable for the engineering controls (every CC6.x,
  CC7.x, CC8.x, PI1.x, C1.x row, and every A1.x row that depends on
  infrastructure code).
- **Security Officer** — accountable for the operating cadence of the
  controls (access reviews, incident response, audit-chain verification,
  Merkle signing, break-glass governance).
- **Compliance Officer** — accountable for the policy and vendor
  surface (policy review, vendor inventory, BAA execution, training).
- **Engineering Lead** — accountable for CI/CD gates and the day-to-day
  operation of the change-control story.
- **Workforce Lead** — accountable for training records, deprovisioning,
  acceptable-use acknowledgments.
- **CEO** — formal policy approver and final approval authority on
  material exceptions.

Where a role does not yet have a named human, the CTO holds it by
default and the gap is recorded in the risk register. Role titles
appear in this directory; names live in the org chart and in the
policy headers.

## Lifecycle

The framework runs on three cadences:

### Continuous

Continuous controls fire on every event (every command, every commit,
every webhook). They are evidenced by:

- A query the auditor can run at any time (`SELECT ... FROM audit_log
WHERE ...`).
- A live configuration the auditor can inspect (Terraform state,
  branch-protection JSON, CI workflow files).
- A CI artifact the auditor can pull (CodeQL report, dependency
  review, SBOM).

### Periodic

Periodic controls fire on a fixed cadence (daily / weekly / monthly /
quarterly / annual). Each periodic control has a script under
[`scripts/soc2/`](../../scripts/soc2/) or [`scripts/security/`](../../scripts/security/)
that produces a dated artifact under
[`evidence/`](../../evidence/) (gitignored — operator-local).

| Cadence   | Examples                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------- |
| Daily     | Merkle-root signing; nightly security digest; audit-chain verification                         |
| Weekly    | Backup-job success summary                                                                     |
| Monthly   | RBAC drift snapshot                                                                            |
| Quarterly | Access review; backup restore drill; vendor SOC 2 confirmation; quarterly evidence pack        |
| Annual    | Policy review; risk assessment; security training; DR tabletop; pentest; vendor risk re-review |

### Per-event

Per-event controls fire when a specific trigger occurs. They produce
evidence at the time of the event:

- Incident response → postmortem PDF.
- Break-glass usage → justification + audit-log row.
- Vendor onboarding → vendor questionnaire + BAA execution.
- Vendor decommissioning → decommissioning checklist.
- Material change → ADR + risk re-assessment if applicable.

### Ownership of the cadence

The Security Officer owns the calendar that schedules each periodic
control and the inbox that receives the per-event triggers. The CTO
owns the continuous controls (they live in code and in CI).

## How an audit uses this directory

1. The auditor reads
   [`trust-service-criteria-mapping.md`](./trust-service-criteria-mapping.md)
   to understand which Pharmax control satisfies each criterion.
2. For each control they sample, the auditor reads the "Implementation"
   column (code path / ADR / migration) to confirm the control is
   designed.
3. The auditor then reads the "Evidence Source" column to retrieve the
   artifact for the period. For continuous controls this is a live
   query or configuration; for periodic controls it is a dated file
   under `evidence/`.
4. The auditor walks through the relevant playbook in
   [`playbooks/`](./playbooks/) to understand the operator-facing
   procedure (who reviews, what sign-off shape, what cadence).
5. The auditor confirms each formal policy in
   [`policies/`](./policies/) — **the legal-counsel-reviewed version**,
   not the stub here — is approved, distributed, and acknowledged.

## How engineering uses this directory

When a new control lands in code:

1. Add an ADR under [`../adr/`](../adr/) if the decision is
   architecturally significant.
2. Add a row to
   [`trust-service-criteria-mapping.md`](./trust-service-criteria-mapping.md)
   pointing at the implementation.
3. Add a row to [`controls-inventory.md`](./controls-inventory.md)
   with the status.
4. Add a row to [`evidence-inventory.md`](./evidence-inventory.md) if
   the control produces a new evidence artifact.
5. If the control is periodic, add or extend a script under
   [`scripts/soc2/`](../../scripts/soc2/).
6. If the control needs a recurring human activity, add or extend a
   playbook under [`playbooks/`](./playbooks/).

When a control is deprecated or replaced, do not delete the row —
mark its status `Deprecated`, note the replacement, and keep the
history. Auditors want to see the lineage.

## Pairing with the existing compliance bundle

This directory deliberately overlaps with the existing
[`../compliance/`](../compliance/),
[`../security/`](../security/), and
[`../governance/`](../governance/) directories. The relationship is:

- **`docs/soc2/`** — the **SOC 2 frame**: TSC → controls → evidence,
  with operator playbooks and stub policies. It is the auditor's
  navigation surface.
- **`docs/security/control-matrix.md`** — the **engineering matrix**
  with SOC 2 + HIPAA in one grid, scoped to the engineering posture.
  Maintained in lockstep with `trust-service-criteria-mapping.md`.
- **`docs/compliance/evidence-collection-guide.md`** — the **how-to**
  for pulling evidence per criterion. Maintained in lockstep with
  `evidence-inventory.md`.
- **`docs/policies/`** — the **authoritative** policy text (legal-
  reviewed where the front-matter says so). `docs/soc2/policies/` is
  the **framework's stub view** of the same policy set, used to
  bootstrap a new policy or to verify the framework's policy coverage.
- **`docs/governance/`** — the **operating procedures** (access review,
  risk assessment, security training, vendor inventory, BAA tracker).

When a fact contradicts across files, the source of truth is:

- For control implementation: the code path / ADR.
- For control status: `controls-inventory.md`.
- For control evidence: `evidence-inventory.md`.
- For policy text: `docs/policies/<name>.md` (the legal-reviewed one),
  not `docs/soc2/policies/<name>.md` (the framework stub).
