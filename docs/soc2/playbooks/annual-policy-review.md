# Playbook: Annual Policy Review

| Field                | Value                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controls satisfied   | CC1.1-1, CC1.2-1, CC1.4-1, CC2.2-1, CC5.1-1, CC5.3-1, CC9.2-1                                                                                       |
| Cadence              | Annual (typically aligned with the end of the fiscal year) plus on-event for material changes                                                       |
| Owner                | Compliance Officer                                                                                                                                  |
| Reviewers            | CTO (technical accuracy), Security Officer (security implications), Workforce Lead (training implications)                                          |
| Final sign-off       | CEO                                                                                                                                                 |
| Evidence destination | `evidence/policies/<year>/` (signed PDFs); `evidence/training/<year>/` (acknowledgments); `evidence/policies/<year>/bundle.zip` (period-end export) |

## Purpose

Refresh every policy in the bundle. Confirm each policy reflects the
current engineering and operational reality, capture CEO approval for
the new version, distribute the updated policies to the workforce,
and collect acknowledgments. Refresh the SOC 2 framework
(`docs/soc2/`) to match.

## Inputs

- [`docs/policies/`](../../policies/) — the authoritative policy
  bundle.
- [`docs/soc2/policies/`](../policies/) — the framework's stub view of
  the same policy set.
- [`docs/soc2/controls-inventory.md`](../controls-inventory.md) and
  [`docs/soc2/trust-service-criteria-mapping.md`](../trust-service-criteria-mapping.md).
- Prior year's policy bundle for diff comparison.
- The current ADR set and engineering posture.

## Procedure

### Step 1 — Engineering reality check

The CTO produces a one-page memo at
`evidence/policies/<year>/engineering-state-memo.md` describing
material engineering changes since the last review (new ADRs, new
vendors, new tenant categories, new data flows). The memo is the
input to the policy review.

### Step 2 — Per-policy review

For each policy in `docs/policies/`:

- Read the existing policy.
- Cross-reference the relevant ADRs and the controls inventory.
- Identify drift between policy text and current practice. Each drift
  is one of:
  - **Policy lags practice** — practice has improved; policy needs to
    catch up. (Usually a safe update.)
  - **Practice lags policy** — practice is weaker than policy claims.
    (Critical: either remediate practice or revise policy down with
    explicit justification.)
  - **Policy and practice both moved** — update both narratives
    cohesively.
- Update the policy with a new version bump and a revision-history row.

Track every change in a per-policy review note at
`evidence/policies/<year>/per-policy-notes.md`.

### Step 3 — Framework refresh

Update the SOC 2 framework to reflect the policy changes:

- [`docs/soc2/policies/`](../policies/) stubs cross-reference the
  authoritative policies — confirm the cross-references still resolve.
- [`docs/soc2/trust-service-criteria-mapping.md`](../trust-service-criteria-mapping.md)
  — confirm every "Implementation" column still points to a live code
  path or policy section.
- [`docs/soc2/controls-inventory.md`](../controls-inventory.md) — flip
  status flags as remediation lands.
- [`docs/soc2/evidence-inventory.md`](../evidence-inventory.md) — add
  rows for any new evidence artifact introduced in the year.

### Step 4 — CEO approval and signing

The CEO reads the policy diffs and approves. For each policy:

- The CEO signs the policy PDF.
- The signed PDF lands at `evidence/policies/<year>/<policy>.pdf`.
- The policy header `Last reviewed` and `Next review` dates are
  updated.

### Step 5 — Workforce distribution and acknowledgment

The Workforce Lead distributes the updated policies to every
employee:

- Distribute via the documented channel (email + acknowledgment
  workflow).
- Collect acknowledgment per employee.
- Acknowledgments land at `evidence/training/<year>/<user>-policy-ack.pdf`.
- Outstanding acknowledgments are tracked; any acknowledgment > 30
  days outstanding is escalated.

### Step 6 — Training refresh

Per CC1.4-1, security and HIPAA training is refreshed annually. The
Workforce Lead schedules the training; completion certificates land
at `evidence/training/<year>/<user>-completion.pdf`.

### Step 7 — Period-end bundle export

The Compliance Officer exports the period-end policy bundle as a
zip and archives it at `evidence/policies/<year>/bundle.zip`. The
zip is the auditor's snapshot of the policy state at the year close.

### Step 8 — Final sign-off

The CEO signs the annual policy-review attestation at
`evidence/policies/<year>/annual-attestation.pdf`. The attestation
names every policy reviewed, the approval date, the bundle hash, and
the workforce acknowledgment status.

## Exception handling

- **Policy approval delayed beyond the year-end window.** Allowed
  with CTO + CEO sign-off; the delay is logged in the risk register.
- **Acknowledgment gap.** Treated as a CC1.1 / CC2.2 deficiency.
  Compliance Officer follows up; persistent non-acknowledgment is a
  workforce policy violation under the acceptable-use policy.
- **Material change mid-year.** Triggers an out-of-cycle review for
  the affected policy. Annual cadence is the floor, not the ceiling.
