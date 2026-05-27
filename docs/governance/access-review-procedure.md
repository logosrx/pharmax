# Access Review Procedure

| Field          | Value                       |
| -------------- | --------------------------- |
| Owner          | [Owner: CTO]                |
| Approver       | [Approver: CEO]             |
| Effective date | [Effective date: TBD]       |
| Last reviewed  | [Last reviewed: YYYY-MM-DD] |
| Next review    | [Next review: YYYY-MM-DD]   |
| Version        | 0.1                         |
| Distribution   | Internal — All staff        |

## 1. Purpose

This document is the standard operating procedure for the quarterly access review. The review is the operational backstop for the [Access Control Policy](../policies/access-control-policy.md) — it ensures that the actual access state in every system Pharmax depends on matches the policy and that stale, broad, or unintended access is found and removed.

This procedure maps to:

- SOC 2 **CC6.2** — registration and authorization of internal users and access modifications.
- SOC 2 **CC6.3** — segregation of duties (verified that conflicting access does not coexist).
- HIPAA **45 CFR § 164.308(a)(4)** — information access management, specifically the periodic review of access authorizations.
- HIPAA **45 CFR § 164.308(a)(3)(ii)(C)** — termination procedures (the review confirms departures took effect everywhere).

## 2. Cadence

The review runs **quarterly**. Each quarter has the following timing:

- **Window opens** at the start of the quarter.
- **Reports generated** during the first month of the quarter.
- **Reviews completed** by the 15th of the second month of the quarter.
- **Sign-off filed** by the end of the second month.
- **Corrective actions tracked** in the engineering tracker, with progress reported at the next quarter's review.

This pacing leaves headroom for the third month of the quarter to absorb any cross-quarter remediation work without slipping into the next review window.

## 3. Scope

The review covers every system in which Pharmax users (humans or service identities) have credentials or roles:

| Scope                  | System                                                                                            | Source for the report                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Operator console users | Pharmax `User` table + role assignments via `@pharmax/rbac`                                       | SQL queries in `scripts/security/access-review/` (delivered by Tier 3 lane O)                |
| Authentication         | Clerk                                                                                             | Clerk dashboard CSV export, organization-scoped                                              |
| Cloud infrastructure   | AWS IAM principals, AWS SSO assignments, AWS service-account roles                                | `aws iam list-users`, `aws sso-admin list-account-assignments`, plus role-policy enumeration |
| Payments               | Stripe dashboard users                                                                            | Stripe dashboard CSV export                                                                  |
| Shipping               | EasyPost portal users; FedEx and UPS direct-account users where applicable                        | Vendor portal export                                                                         |
| Source code and CI     | GitHub organization members and outside collaborators with repo access                            | `gh api orgs/pharmax/members` + per-repo collaborator listing                                |
| Observability          | Sentry users, Datadog or Honeycomb users (when selected)                                          | Vendor admin export                                                                          |
| Communications         | Resend users (when in use)                                                                        | Vendor admin export                                                                          |
| Workforce credentials  | 1Password vault membership and group access                                                       | 1Password admin export                                                                       |
| Database               | PostgreSQL roles in use, focused on `pharmax_app`, `pharmax_system`, and any human-attached roles | `\du` in psql against the production read-replica, plus IAM-related Secrets Manager queries  |

The exact set of vendor portals tracks the current [vendor inventory](./vendor-inventory.md). When a vendor is added or removed under [Vendor Management Policy](../policies/vendor-management-policy.md), the next quarterly review picks up the change.

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

The CEO is notified of the sign-off and reviews the executive summary; the CEO's review is not a formal approval but is part of the management-oversight loop.

### 5.6 Track corrective actions to closure

Corrective tickets filed during the review are tracked in the engineering tracker. Each ticket has:

- A link to the review row that surfaced it.
- A target completion date (default: end of the review window — within ~30 days).
- An assigned owner.

At the next quarter's review kick-off, the prior-quarter corrective tickets are confirmed closed. A ticket that has not closed escalates to the CEO with a stated reason.

## 6. SQL and CLI scripts

The SQL queries and CLI invocations that produce the per-scope reports live in `scripts/security/access-review/` (delivered by the Tier 3 access-review lane). The current planned set:

- `operator-console.ts` — Pharmax `User` rows + effective role assignments + last-activity timestamp.
- `clerk-users.ts` — Clerk users via the Clerk API.
- `aws-principals.ts` — AWS IAM users, AWS SSO assignments, service-account roles.
- `stripe-users.ts` — Stripe team-member listing via the Stripe API.
- `easypost-users.ts` — EasyPost team listing.
- `github-collaborators.ts` — GitHub org members + outside collaborators.
- `sentry-users.ts` — Sentry team listing.
- `observability-users.ts` — Datadog or Honeycomb team listing (once selected).
- `onepassword-membership.ts` — 1Password vault membership.
- `database-roles.ts` — PostgreSQL role enumeration via `\du`.

The scripts are designed to be reproducible — same input set, same output. Reproducibility matters for the audit trail; an auditor who asks "what did the world look like in Q2 of last year?" needs to be able to re-run.

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

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
