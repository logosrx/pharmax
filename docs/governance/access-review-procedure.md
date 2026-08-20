# Access Review Procedure

| Field          | Value                |
| -------------- | -------------------- |
| Owner          | CTO                  |
| Approver       | CEO                  |
| Effective date | 2026-08-18           |
| Last reviewed  | 2026-08-18           |
| Next review    | 2027-08-18           |
| Version        | 1.0                  |
| Distribution   | Internal — All staff |

## 1. Purpose

This document is the standard operating procedure for the quarterly access review. The review is the operational backstop for the [Access Control Policy](../policies/access-control-policy.md) — it ensures that the actual access state in every system Pharmax depends on matches the policy and that stale, broad, or unintended access is found and removed.

This procedure maps to:

- SOC 2 **CC6.2** — registration and authorization of internal users and access modifications.
- SOC 2 **CC6.3** — segregation of duties (verified that conflicting access does not coexist).
- HIPAA **45 CFR § 164.308(a)(4)** — information access management, specifically the periodic review of access authorizations.
- HIPAA **45 CFR § 164.308(a)(3)(ii)(C)** — termination procedures (the review confirms departures took effect everywhere).

### 1.1 This is the only quarterly compliance event

Several controls that read like independent quarterly commitments elsewhere in
the bundle are line items **inside this review**, not separate exercises:

- KMS grant review ([risk register](./risk-register.md), R-KMS)
- Vendor portal access ([Information Security Policy](../policies/information-security-policy.md) §)
- BAA-vs-integration cross-check ([BAA tracker](./baa-tracker.md), and §5 step 4 below)
- Privileged-access list confirmation ([Access Control Policy](../policies/access-control-policy.md) §)
- Training completion status ([Security Training Program](./security-training-program.md) §)

They are consolidated here deliberately. Written as five separate quarterly
commitments they produce no additional assurance — the work is the same walk
through the same reports — while creating five additional dated promises that an
assessor can find unkept. One event with a fuller checklist is both easier to
sustain and easier to evidence, because it produces one signed artifact instead
of five that must each be located.

Everything else in the bundle is annual or event-triggered. If a new control
needs periodic verification, the default answer is to add a line to this
checklist rather than to create a sixth recurring event.

## 2. Cadence

The review runs **quarterly** — the one cadence in the bundle kept at that
frequency. HIPAA § 164.308(a)(4) says only "periodic", so this is a chosen
number rather than a mandated one, but it is the cadence the market expects for
SOC 2 CC6.2/CC6.3, access drift is silent and continuous, and the tooling makes
the review cheap enough to sustain. Relaxing the one quarterly control that is
both expected and inexpensive would be a false economy.

Each quarter has the following timing:

- **Window opens** at the start of the quarter.
- **Reports generated** during the first month of the quarter.
- **Reviews completed** by the 15th of the second month of the quarter.
- **Sign-off filed** by the end of the second month.
- **Corrective actions tracked** in the engineering tracker, with progress reported at the next quarter's review.

This pacing leaves headroom for the third month of the quarter to absorb any cross-quarter remediation work without slipping into the next review window.

## 3. Scope

The review covers every system in which Pharmax users (humans or service identities) have credentials or roles:

| Scope                  | System                                                                                            | Source for the report                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Operator console users | Pharmax `User` table + role assignments via `@pharmax/rbac`                                       | `scripts/security/run-access-review.ts`                                                     |
| Authentication         | In-house (`@pharmax/auth`) — reviewed as part of the `User` table above                           | Same as operator console; Clerk was retired 2026-07 per ADR-0030                            |
| Cloud infrastructure   | AWS account root, IAM principals, Identity Center assignments, KMS key policies                   | `scripts/security/access-review/infrastructure-access.ts`, plus the management account (§6) |
| Payments               | Stripe dashboard users                                                                            | Stripe dashboard CSV export                                                                 |
| Shipping               | EasyPost portal users; FedEx and UPS direct-account users where applicable                        | Vendor portal export                                                                        |
| Source code and CI     | GitHub organization members and outside collaborators with repo access                            | `gh api orgs/pharmax/members` + per-repo collaborator listing                               |
| Observability          | Sentry users, Datadog or Honeycomb users (when selected)                                          | Vendor admin export                                                                         |
| Communications         | Resend users (when in use)                                                                        | Vendor admin export                                                                         |
| Workforce credentials  | 1Password vault membership and group access                                                       | 1Password admin export                                                                      |
| Database               | PostgreSQL roles in use, focused on `pharmax_app`, `pharmax_system`, and any human-attached roles | `\du` in psql against the production read-replica, plus IAM-related Secrets Manager queries |

The exact set of vendor portals tracks the current [vendor inventory](./vendor-inventory.md). When a vendor is added or removed under [Vendor Management Policy](../policies/vendor-management-policy.md), the next quarterly review picks up the change.

### 3.1 Before the first tenant, the application half is empty and the infrastructure half is not

Until an organization exists, `run-access-review.ts` has nothing to read: it takes an organization UUID and an operator who is a user inside that organization, and with neither present it exits rather than producing an empty report.

That is the correct behaviour and it is not a gap in the review. An access review reviews who can reach PHI; with no tenants, no users and no PHI there is genuinely nothing on that surface to review. "No organizations existed during this period" is a complete answer, and creating one so the script has something to read would manufacture the evidence rather than produce it.

The conclusion that does **not** follow is that the quarter has no access to review. Every principal that can reach the production database, the KMS keys that will wrap every tenant DEK, and the pipeline that deploys to the environment holding PHI exists today and is reviewable today. That is the [infrastructure access review worksheet](../compliance/infrastructure-access-review-worksheet.md), and in the pre-tenant quarters it is the whole review.

Record the application half as "not run — zero organizations" in the worksheet §2 rather than omitting it. An omission and a reasoned non-applicability look identical in an evidence folder a year later, and only one of them is defensible.

## 4. Roles

- **The CTO** owns the review and signs off on the consolidated report.
- **The vendor-portal owner** for each system (often also the CTO for our current team size) generates the report and walks each principal.
- **For Pharmax-internal `OrgAdmin` access** (customer-side role assignments), the customer's `OrgAdmin` reviews their own org's users; Pharmax does not unilaterally review a customer's internal user list. Pharmax does verify that there are no Pharmax employees inadvertently holding `OrgAdmin` access in a customer org (that would be an [Acceptable Use Policy](../policies/acceptable-use-policy.md) §3.1 violation).

## 5. Procedure

### 5.1 Generate reports

For each scope in §3, generate the access report into a working folder for the quarter:

```bash
# Example: producing the operator-console access report
pnpm tsx scripts/security/access-review/operator-console.ts \
  --org-id <organizationId> \
  --output evidence/access-reviews/<YYYY>-Q<#>/operator-console.csv
```

The reports are CSV with at minimum:

- Principal identifier (Clerk user id, AWS IAM ARN, vendor user id, etc.).
- Email or display name.
- Role or permission set.
- Scope (organization / site / clinic / team / bucket where applicable).
- Last activity timestamp (where the source system exposes it).
- Date access was granted.
- Notes (provisional access, contractor, etc.).

### 5.2 Reviewer walkthrough

The reviewer (CTO for most scopes) walks each row of each report and decides one of:

- **Keep** — access is appropriate and current. Rationale recorded in the `keep_reason` column.
- **Reduce** — access is broader than needed. Rationale recorded; a corrective ticket is filed to narrow the role.
- **Remove** — access is no longer needed (departed user, role change, contract end). A corrective ticket is filed to remove access by the end of the review window.
- **Investigate** — the principal is unfamiliar or the access pattern is unexpected. Escalated to [Incident Response Policy](../policies/incident-response-policy.md) at SEV2 pending classification.

The reviewer's decision per row is the audit-trail artifact. A row with no decision recorded is itself a finding.

### 5.3 Cross-checks

In addition to the per-row walkthrough, the reviewer performs the following cross-checks:

1. **Departed-user check.** Every departure logged in the prior quarter is verified absent in every scope. A departed user who still has access anywhere is an immediate corrective.
2. **Role-change check.** Every role change executed in the prior quarter is verified — the prior role is gone, the new role is present.
3. **Privileged-access check.** The privileged-access list ([Access Control Policy](../policies/access-control-policy.md) §9) is verified — no unexpected names hold AWS root, GitHub org-owner, Clerk admin, Stripe owner, or `pharmax_system` access.
4. **BAA-vs-integration cross-check.** Per [BAA tracker](./baa-tracker.md) §"Quarterly cross-reference check", confirm every active PHI-flowing integration is backed by an executed BAA.
5. **SoD principal check.** For every operator who has `Pharmacist` capabilities, verify no override has granted them both `PV1_APPROVE` and `FINAL_APPROVE` on the same scope outside of a documented training exception.
6. **System-identity check.** Verify the `WebhookService` and print-agent service identities have no `clerkUserId` and no human-attached interactive access.
7. **Null-approver break-glass check.** List `break_glass_session` rows opened in the period with `approvedByUserId IS NULL` and confirm each was genuinely a single-operator situation rather than a skipped approval. Four-eyes is required whenever a second engineer exists, and the code permits a null approver so that the emergency tool stays usable when one does not — see the [break-glass runbook](../compliance/break-glass-runbook.md) single-operator exception and R-029. Reviewing these is what keeps the exception an exception; unreviewed, "no approver was available" becomes the default explanation for every session.

### 5.4 Consolidation

Once every report is walked, the reviewer assembles a consolidated quarterly access-review summary:

- One-page executive summary stating the scope, the date the review ran, the headcount per scope, the number of corrective actions filed, and any anomalies.
- Per-scope detail with the underlying CSVs attached.
- Any findings escalated to incident response with the incident reference.

The consolidated summary is the artifact the CTO signs.

### 5.5 Sign-off and archive

The CTO signs the consolidated summary. The signed PDF is archived at:

```
evidence/access-reviews/<YYYY>-Q<#>/summary-signed.pdf
```

with the underlying CSVs and decision records under the same folder. The folder is retained for the duration required by HIPAA documentation retention (six years per 45 CFR § 164.530(j)).

**Record the SHA-256 of each signed artifact in the [evidence digest ledger](../compliance/evidence-digest-ledger.md).** `evidence/` is gitignored, deliberately — the artifacts name principals, accounts and infrastructure that should not sit in the source repository. The consequence is that a signed file has no integrity story of its own: a worksheet edited months later is indistinguishable from one that was not. Committing the digest fixes which document was signed, at the cost of one command. Do it after signing, not before.

The CEO is notified of the sign-off and reviews the executive summary; the CEO's review is not a formal approval but is part of the management-oversight loop.

### 5.6 Track corrective actions to closure

Corrective tickets filed during the review are tracked in the engineering tracker. Each ticket has:

- A link to the review row that surfaced it.
- A target completion date (default: end of the review window — within ~30 days).
- An assigned owner.

At the next quarter's review kick-off, the prior-quarter corrective tickets are confirmed closed. A ticket that has not closed escalates to the CEO with a stated reason.

## 6. SQL and CLI scripts

Two scripts exist today. Both are reproducible — same input set, same output — which matters for the audit trail, because an auditor who asks "what did the world look like in Q2 of last year?" needs the run to be repeatable.

| Script                                                    | Covers                                                                                                                                                                                                                                                    | Status |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `scripts/security/run-access-review.ts`                   | Application RBAC for one organization: `User` rows, effective role assignments, elevated roles, stale assignments. Writes a digest-sealed `access_review_snapshot` row and a JSON report.                                                                 | Exists |
| `scripts/security/access-review/infrastructure-access.ts` | AWS account root posture, IAM users, Identity Center instances, KMS customer-managed key policies, GitHub collaborators, deploy keys and production-environment reviewers. Writes `infrastructure-access.csv` with blank `decision` columns for the walk. | Exists |

Everything else in §3 is enumerated manually into the [infrastructure access review worksheet](../compliance/infrastructure-access-review-worksheet.md) §4. That is a deliberate stopping point rather than a backlog. A vendor with one or two human users does not repay an API integration and a credential to maintain, and each such script would be one more thing that can silently stop working — a report that returns an empty list because its token expired reads exactly like a clean review.

**An earlier version of this section listed ten planned scripts, none of which existed.** Several named vendors that have since been retired (Clerk, per ADR-0030) or are being decommissioned (EasyPost) or were never selected (Datadog/Honeycomb). A procedure that promises tooling it does not have is the same defect as a risk register that credits a control it does not have — see R-027 — and it is worse here, because the promise is what a reviewer relies on when deciding the review is complete.

If a manual surface grows past a handful of principals, add a script and add a row above. The test for whether it is worth automating is whether a human can still enumerate it accurately in a few minutes.

## 7. Off-cycle reviews

In addition to the quarterly review, an off-cycle review is triggered by:

- An involuntary departure — deprovisioning must complete the same business day; the next access review confirms.
- A SEV0 / SEV1 incident where credential compromise is suspected — an immediate scoped review of the affected systems.
- A material change in vendor list — the affected vendor is reviewed at the next quarter or sooner if needed.
- A finding from an auditor or HIPAA assessor.

Off-cycle reviews follow the same procedure, scoped to the trigger.

## 8. Cross-references

- [Access Control Policy](../policies/access-control-policy.md) — the policy parent.
- [Vendor Management Policy](../policies/vendor-management-policy.md) — vendor scope.
- [BAA tracker](./baa-tracker.md) — the BAA-vs-integration cross-check.
- [vendor inventory](./vendor-inventory.md) — the source for which scopes to review.
- [Information Security Policy](../policies/information-security-policy.md) — overall context.
- ADR 0011 — Separation of Duties (the SoD cross-check rationale).
- ADR 0015 — Clerk authentication, Pharmax authorization.
- HIPAA 45 CFR § 164.308(a)(3), § 164.308(a)(4).

## Revision history

| Version | Date       | Author | Change                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1     | 2026-05-27 | CTO    | Initial drafting                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1.0     | 2026-08-18 | CEO    | Adopted. Effective date set; annual review cadence begins.                                                                                                                                                                                                                                                                                                                                                                               |
| 1.1     | 2026-08-18 | CEO    | §6 corrected: it listed ten scripts that did not exist, several for retired or never-selected vendors. Replaced with the two that do, and a stated reason for not automating the rest. §3 refreshed for the retirement of Clerk and for the infrastructure script. New §3.1 states how the review works before the first tenant exists, when the application half is legitimately empty and the infrastructure half is the whole review. |
| 1.2     | 2026-08-19 | CEO    | Added cross-check §5.3.7, the null-approver break-glass review. The break-glass runbook now permits a session with no second approver when only one operator exists, and that permission is only safe if the exceptions are read by someone afterwards. See R-029.                                                                                                                                                                       |
| 1.3     | 2026-08-19 | CTO    | §5.5 now requires the signed artifact's SHA-256 in the [evidence digest ledger](../compliance/evidence-digest-ledger.md). Surfaced by the first signed review: `evidence/` is gitignored, so nothing established which version of the worksheet had been signed.                                                                                                                                                                         |
