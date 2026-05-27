# SOC 2 framework policy STUBS — NOT AUTHORITATIVE

> **These policy documents are STUBS. They MUST be reviewed by legal
> counsel and your SOC 2 auditor before being treated as authoritative.**
>
> **The structure here is the _platform's evidence_ that the policy
> set exists in the expected shape — the actual policy text is a
> legal/compliance deliverable, not an engineering one.**

## Why these stubs exist

The SOC 2 framework needs a place where the policy structure is
expressed as part of the framework, so that:

1. An engineer adding a new control can see which policy it falls
   under and update both surfaces coherently.
2. The framework's controls inventory and TSC mapping can
   cross-reference policies by name even before the legally-reviewed
   text is finalized.
3. The auditor can read a single navigable structure that names every
   policy in scope.

The stubs do **not** replace the authoritative versions, which live
at [`../../policies/`](../../policies/). When a fact conflicts, the
authoritative version wins.

## The relationship to `docs/policies/`

| Authoritative (`docs/policies/`)                                                                                  | Stub (`docs/soc2/policies/`)                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The legally-reviewed text. The version employees acknowledge. The version the auditor reads.                      | The framework's structural placeholder. The version engineering updates when a new control changes the policy's scope. |
| Has a complete header (Owner / Approver / Effective date / Last reviewed / Next review / Version / Distribution). | Has a stub header marked `<TBD>` where legal review fills in.                                                          |
| Contains complete prose under each section.                                                                       | Contains section markers and `<TBD by legal counsel>` placeholders.                                                    |
| Changes go through the annual policy review playbook + CEO sign-off.                                              | Changes track the engineering reality and pre-date legal review.                                                       |

The stubs and the authoritative policies are kept in sync during the
annual policy review (see
[`../playbooks/annual-policy-review.md`](../playbooks/annual-policy-review.md)).

## Required legal review

Each stub explicitly flags content that **requires legal counsel
review** before publication. Categories of prose that must be drafted
by counsel (not by engineering):

- Statements of legal obligation (HIPAA, state breach laws, sectoral
  rules).
- Statements about regulator-notification thresholds and timing.
- Statements about customer indemnification, liability allocation, or
  warranty.
- Statements about employee sanctions and termination procedure.
- Statements about retention obligations (where retention crosses a
  regulatory threshold).
- Statements about international data transfer (GDPR, UK GDPR,
  Canadian PIPEDA where applicable).

Stubs use the marker `<TBD by legal counsel: reason>` for any prose
in these categories. Auditors should treat the presence of unresolved
`<TBD by legal counsel>` markers as a control deficiency.

## Required auditor review

Each stub also flags content that **requires SOC 2 auditor review**
before the policy can be treated as audit-ready:

- Specific control language tied to TSC criteria where wording
  precision matters for audit findings.
- Cadence commitments (e.g., "annual" vs "biennial") that map to the
  controls inventory.
- Sign-off authority specifications.

Stubs use the marker `<TBD by SOC 2 auditor: reason>` for any prose
in these categories.

## The stub set

| File                                                   | Authoritative version                                                                                                                           | Owner role         | Audience                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------ |
| [`information-security.md`](./information-security.md) | [`../../policies/information-security-policy.md`](../../policies/information-security-policy.md)                                                | CTO                | All employees            |
| [`access-control.md`](./access-control.md)             | [`../../policies/access-control-policy.md`](../../policies/access-control-policy.md)                                                            | CTO                | All engineering + admins |
| [`change-management.md`](./change-management.md)       | [`../../policies/change-management-policy.md`](../../policies/change-management-policy.md)                                                      | Engineering Lead   | Engineering              |
| [`incident-response.md`](./incident-response.md)       | [`../../policies/incident-response-policy.md`](../../policies/incident-response-policy.md)                                                      | Security Officer   | All employees            |
| [`data-classification.md`](./data-classification.md)   | [`../../policies/data-classification.md`](../../policies/data-classification.md)                                                                | Compliance Officer | All employees            |
| [`backup-and-recovery.md`](./backup-and-recovery.md)   | [`../../policies/business-continuity-and-disaster-recovery.md`](../../policies/business-continuity-and-disaster-recovery.md) (recovery section) | Engineering Lead   | Engineering              |
| [`vendor-management.md`](./vendor-management.md)       | [`../../policies/vendor-management-policy.md`](../../policies/vendor-management-policy.md)                                                      | Compliance Officer | Engineering + Compliance |
| [`acceptable-use.md`](./acceptable-use.md)             | [`../../policies/acceptable-use-policy.md`](../../policies/acceptable-use-policy.md)                                                            | Workforce Lead     | All employees            |
| [`business-continuity.md`](./business-continuity.md)   | [`../../policies/business-continuity-and-disaster-recovery.md`](../../policies/business-continuity-and-disaster-recovery.md)                    | CTO                | Engineering + leadership |

## Stub template

Every stub follows the same shape:

1. **Header** — Owner / Approver / Effective date / Last reviewed /
   Next review / Version / Distribution. All `<TBD>` until legal +
   auditor sign-off.
2. **Purpose** — what the policy exists to accomplish.
3. **Scope** — who and what the policy covers.
4. **Policy statements** — the actual rules.
5. **Roles and responsibilities** — who does what.
6. **Enforcement and sanctions** — what happens on non-compliance.
7. **Review cadence** — how often the policy is re-examined.
8. **References** — cross-references to ADRs, controls, and other
   policies.
9. **Revision history** — version table.

## Do not commit signed PDFs to this repo

Signed PDFs of policy approvals, training acknowledgments, and
sanctions live under `evidence/` (gitignored). This repo holds the
markdown source-of-truth and the stub framework only.
