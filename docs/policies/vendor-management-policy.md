# Vendor Management Policy

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

This policy governs how Pharmax engages, reviews, and decommissions third-party vendors that store, process, transmit, or have administrative access to Pharmax data. It is the operational expression of:

- SOC 2 **CC9.2** — vendor and business-partner management.
- HIPAA **45 CFR § 164.308(b)(1)** — Business Associate Contracts (BAAs).
- HIPAA **45 CFR § 164.314(a)** — organizational requirements for BAs and sub-BAs.

Pharmax is a Business Associate of pharmacy customers and is itself a covered downstream relationship for several upstream vendors. The vendor program is what keeps those relationships explicit and contractual.

The standing vendor list — what each vendor does, what data they touch, BAA status — lives in [`../governance/vendor-inventory.md`](../governance/vendor-inventory.md). BAA-execution status lives in [`../governance/baa-tracker.md`](../governance/baa-tracker.md). This policy is the procedure; the inventory and tracker are the data.

## 2. Scope

This policy applies to any third-party engagement where Pharmax data — or access to Pharmax systems — crosses an organizational boundary. That includes:

- SaaS vendors that process Pharmax-owned data (AWS, Clerk, Stripe, EasyPost, FedEx, UPS, Sentry, Datadog or Honeycomb, Resend, Vercel where applicable, etc.).
- Hosting and infrastructure providers (AWS).
- Identity providers (Clerk).
- Carriers (FedEx, UPS, others as added).
- Payment processors (Stripe).
- Communications providers (Resend or equivalent).
- Observability and security tooling (Sentry, Datadog or Honeycomb, GitHub, 1Password).
- Open-source dependency providers (pnpm registry, npm, GitHub container registry) — these are reviewed under the dependency CVE control rather than the bilateral-vendor process below.
- Any contractor or consultant with access to Pharmax systems is covered by §7 (workforce-equivalent treatment) rather than this section.

This policy does not apply to one-off transactional vendors that never touch Pharmax data (office supplies, payroll if PHI-free, etc.). Those are handled under standard purchasing.

## 3. Vendor onboarding workflow

A new vendor is engaged via the following steps. The CTO is the approver for every vendor that touches Confidential or Restricted data; the CEO is the approver for any vendor whose engagement would constitute a material change to the security posture (a new sub-processor of PHI, a new payment processor, a new identity provider).

### 3.1 Step 1 — Need and alternatives

The requester opens a ticket stating:

- The business need.
- The category of data the vendor will touch (per the [Data Classification Policy](./data-classification.md)).
- Whether the vendor will receive PHI.
- The alternatives considered and the reason for the proposed choice.

A vendor that would receive PHI requires that the alternatives include a non-PHI architecture if one is reasonable. The reflex is "fewer PHI processors are better"; the policy preserves that reflex by forcing a written justification.

### 3.2 Step 2 — Security review

For any vendor that will touch Confidential or Restricted data, the requester collects:

- The vendor's most recent **SOC 2 Type 2 report** (or an equivalent like ISO 27001, with the equivalent rationale in the ticket). A bridge letter is acceptable if the report is older than 12 months.
- The vendor's **encryption attestation** — at rest, in transit, and key custody. For PHI-touching vendors, the attestation must include the key model (customer-managed keys preferred; vendor-managed keys acceptable with rationale).
- The vendor's **sub-processor disclosure** — the downstream vendors they use for Pharmax data, with their geographic location and the data they each touch.
- The vendor's **incident-notification commitment** — turnaround time for a security event affecting Pharmax data. For PHI-touching vendors, no longer than 60 calendar days from discovery per the HIPAA Breach Notification Rule (45 CFR § 164.410); shorter is preferred.
- The vendor's **data-residency commitment** — that data stays in US AWS regions for Pharmax tenants, consistent with the [Data Classification Policy](./data-classification.md) §7.

For a vendor that already provides published SOC 2 / HIPAA-readiness packets to prospective customers, this is a quick collection step. For a vendor that does not, the requester sends a security questionnaire — a short, focused list of the items above. We do not send 400-question questionnaires unless a customer's BAA requires it.

The CTO reviews the collected materials. Gaps are either remediated (the vendor provides the missing artifact), accepted with a documented compensating control, or the vendor is rejected.

### 3.3 Step 3 — BAA execution (for PHI-touching vendors)

A vendor that will receive PHI must execute a **Business Associate Agreement (BAA)** with Pharmax before any production data flows. The BAA is in addition to the master services agreement and addresses:

- Permitted and required uses and disclosures of PHI (45 CFR § 164.504(e)(2)).
- The vendor's obligation to safeguard PHI in line with the HIPAA Security Rule.
- Sub-contractor flow-down (sub-BAAs).
- Breach notification turnaround (no more than 60 days from discovery, shorter preferred).
- Return or destruction of PHI at termination.
- Cooperation obligations for HIPAA assessments and audits.

The executed BAA is filed under `evidence/baa/<vendor>/<YYYY-MM>-baa-executed.pdf` and recorded in [`../governance/baa-tracker.md`](../governance/baa-tracker.md). Until a BAA is executed, no PHI flows to that vendor — the engineering switch (an integration enable-flag, a tenant configuration value, an export job) stays off.

For vendors **that are not Business Associates** (e.g. a customer-facing carrier portal where the customer transmits their own data, or a vendor whose architecture means they never see Pharmax-managed PHI), the BAA-required column in the inventory is `N/A` and the rationale is recorded in the inventory's notes column.

### 3.4 Step 4 — Contract and onboarding

After security review and BAA execution (if applicable), the master services agreement and any data-processing addendum are signed. Onboarding includes:

- Provisioning Pharmax users in the vendor's portal with the minimum required permissions per the [Access Control Policy](./access-control-policy.md).
- Recording the vendor's billing owner, technical owner, and security contact in the vendor inventory.
- Wiring the integration if applicable, with the integration-specific runbook section added to `../RUNBOOK.md`.
- Configuring the engineering switch (`STRIPE_*`, `EASYPOST_*`, etc.) and rolling it out per the [Change Management Policy](./change-management-policy.md).

### 3.5 Step 5 — Recording in inventory and tracker

The vendor is recorded in:

- [`../governance/vendor-inventory.md`](../governance/vendor-inventory.md) — category, data accessed, BAA-required flag, SOC 2 report on file, contract URL, owner, last-review date.
- [`../governance/baa-tracker.md`](../governance/baa-tracker.md) — BAA status, effective date, next review date, notes.

A vendor that does not appear in the inventory has not been onboarded under this policy. Engineering integrations against an undocumented vendor fail review under the [Change Management Policy](./change-management-policy.md) §3.

## 4. Annual review

Every vendor in the inventory is reviewed at least annually. The annual review covers:

- **SOC 2 report refresh.** Is the report on file current (within 12 months, or accompanied by a bridge letter)? If not, the vendor delivers a current report or accepts a compensating control documented in the inventory.
- **Sub-processor changes.** Does the vendor's sub-processor list match what we have on file? New sub-processors get the security-review treatment from §3.2.
- **Incident history.** Did the vendor disclose any security incident affecting Pharmax data in the past 12 months? If yes, what was the remediation?
- **Contract status.** Is the master agreement current? Renewal upcoming?
- **Usage.** Are we still using the vendor? An unused vendor is a candidate for decommissioning (§6).
- **BAA refresh.** For PHI-touching vendors, is the BAA still current? Many BAAs auto-renew; document the renewal in the tracker.

The annual review schedule is staggered across the year so the CTO is not facing every vendor review in a single month. The schedule is in the vendor inventory's `last_review` column — a vendor reviewed in Q1 of year N is due for review by Q1 of year N+1.

For high-risk vendors (PHI-touching, payments, identity), the review cadence may be **more frequent than annual** if circumstances warrant — for example, after a publicly disclosed incident at the vendor, after a significant architectural change in the vendor's offering, or after a contract renegotiation.

## 5. Ongoing monitoring

Between annual reviews, Pharmax monitors vendors via:

- **Public security disclosures.** When a major vendor (AWS, Clerk, Stripe, EasyPost) discloses an incident or a critical CVE, the CTO assesses Pharmax exposure within one business day and records the assessment in the risk register if material.
- **Vendor status pages.** The on-call engineer references vendor status pages during incident response per `../INCIDENT_RESPONSE.md` §"The first 5 minutes".
- **SOC 2 bridge letters.** Vendors that publish quarterly bridge letters are tracked; a missed bridge letter triggers a follow-up.
- **Subprocessor change notifications.** Where the vendor commits to notifying us of subprocessor changes, the notification is reviewed by the CTO and either accepted or escalated.

## 6. Vendor decommissioning

A vendor is decommissioned when:

- The business need is over (we migrated off, the integration is retired).
- The vendor fails an annual review and remediation is not feasible.
- A security incident at the vendor requires Pharmax to terminate the relationship.

The decommissioning workflow:

1. Set an end-date in the vendor inventory.
2. Disable the engineering integration (the `*_API_KEY` env vars come out of AWS Secrets Manager; the vendor-specific tenant configuration is set to disabled).
3. Pause all data flows to the vendor.
4. **Request data return or destruction** per the BAA (for PHI-touching vendors) or per the master agreement (for others). The return or destruction is documented; for PHI, the certificate of destruction is filed under `evidence/baa/<vendor>/<YYYY-MM>-destruction-cert.pdf`.
5. Revoke Pharmax user access to the vendor's portal. Remove the vendor's credentials from 1Password and from AWS Secrets Manager. The next quarterly access review confirms removal.
6. Update the vendor inventory `status` to `DECOMMISSIONED` (we keep the row for historical reference) and the BAA tracker `status` to `terminated`.
7. If the vendor had any standing IP allowlist with Pharmax infrastructure, remove the allowlist entry.

For a PHI-touching vendor, decommissioning is not complete until the destruction certificate (or a confirmation of secure return) is on file. The CTO signs off on closure.

## 7. Contractors and consultants

Contractors and consultants who are granted access to Pharmax systems are treated as workforce members for the duration of the engagement:

- They sign the [Acceptable Use Policy](./acceptable-use-policy.md) acknowledgment.
- They complete the same security and HIPAA training as employees per [`../governance/security-training-program.md`](../governance/security-training-program.md).
- They are provisioned and deprovisioned via the standard [Access Control Policy](./access-control-policy.md) workflows.
- Their access is reviewed in the quarterly access reviews.

A contractor's organization may be a separate vendor in the inventory if data flows to the organization's infrastructure (not just to the individual). The individual-vs-organization line is recorded in the inventory's notes column.

## 8. Sub-processor flow-down

Pharmax customers (pharmacy organizations) have BAAs with Pharmax. When Pharmax engages a vendor that becomes a sub-processor of customer PHI, the engagement is disclosed to customers under the master agreement notification clause. Customers may object to a new sub-processor; the process for handling objections is in the master agreement.

The current sub-processor list is published in our customer-facing security packet (sourced from the vendor inventory). A change to the sub-processor list is communicated to affected customers within the contractually agreed notification window.

## 9. Cross-references

- [Information Security Policy](./information-security-policy.md) — parent.
- [Data Classification Policy](./data-classification.md) — defines what data each vendor is allowed to touch.
- [Access Control Policy](./access-control-policy.md) — how Pharmax users are provisioned in vendor portals.
- [Incident Response Policy](./incident-response-policy.md) — vendor-side incident handling on the Pharmax side.
- [`../governance/vendor-inventory.md`](../governance/vendor-inventory.md) — current vendor list.
- [`../governance/baa-tracker.md`](../governance/baa-tracker.md) — BAA execution status per vendor.
- HIPAA 45 CFR § 164.308(b), § 164.314(a), § 164.504(e), § 164.410.

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
