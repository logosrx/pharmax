# BAA Tracker

| Field          | Value                       |
| -------------- | --------------------------- |
| Owner          | [Owner: CTO]                |
| Approver       | [Approver: CEO]             |
| Effective date | [Effective date: TBD]       |
| Last reviewed  | [Last reviewed: YYYY-MM-DD] |
| Next review    | [Next review: YYYY-MM-DD]   |
| Version        | 0.1                         |
| Distribution   | Internal — All staff        |

This document tracks the Business Associate Agreement status for every vendor in the [vendor inventory](./vendor-inventory.md) that requires one. It is the standing record an auditor or customer security reviewer asks for first.

BAA status vocabulary (controlled):

- **`not requested`** — engagement is current but a BAA has not been initiated yet. Engineering switch (integration enable-flag) for any PHI flow must be **off**.
- **`requested`** — BAA terms are with the vendor's legal team. Engineering switch still **off** for any PHI flow.
- **`executed`** — BAA is signed by both parties and on file. Engineering switch may be **on**.
- **`N/A — not a BA`** — vendor does not receive PHI by design; no BAA required. See vendor-inventory notes for the design rationale.
- **`terminated`** — engagement ended; BAA termination clauses observed; PHI returned or destroyed per the BAA termination provisions.

A BAA-required vendor whose status is not `executed` must not receive PHI. Engineering integrations check the BAA status via the [vendor inventory](./vendor-inventory.md) cross-reference; the operational switch for PHI flow stays off until the status flips.

## Tracker

| Vendor                                                     | BAA status        | BAA effective date        | BAA review date        | Owner | Notes / evidence                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ----------------- | ------------------------- | ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS** <a id="aws"></a>                                   | [BAA status: TBD] | [BAA effective date: TBD] | [BAA review date: TBD] | CTO   | AWS standard BAA covers HIPAA Eligible Services. Confirm the eligible-services list during the annual review covers RDS, S3, KMS, ECS/Fargate, Secrets Manager, CloudWatch Logs, CloudTrail. Evidence: `evidence/baa/aws/<YYYY-MM>-baa-executed.pdf`.   |
| **Clerk** <a id="clerk"></a>                               | [BAA status: TBD] | [BAA effective date: TBD] | [BAA review date: TBD] | CTO   | Clerk publishes a BAA for enterprise plans. Operator identity is treated as workflow-record-adjacent; we procure a BAA for safety even though strict PHI scope is debatable. Evidence: `evidence/baa/clerk/<YYYY-MM>-baa-executed.pdf`.                 |
| **Stripe** <a id="stripe"></a>                             | N/A — not a BA    | n/a                       | [BAA review date: TBD] | CTO   | Stripe does not receive PHI by design — invoice descriptions and line items omit patient identifiers (see `packages/billing/`). The N/A status is reaffirmed at the annual review; a change in invoice content would require revisiting.                |
| **EasyPost** <a id="easypost"></a>                         | [BAA status: TBD] | [BAA effective date: TBD] | [BAA review date: TBD] | CTO   | Recipient addresses on labels are PHI by linkage. EasyPost publishes a BAA on request. Evidence: `evidence/baa/easypost/<YYYY-MM>-baa-executed.pdf`.                                                                                                    |
| **FedEx** <a id="fedex"></a>                               | [BAA status: TBD] | [BAA effective date: TBD] | [BAA review date: TBD] | CTO   | Direct FedEx engagement (tenant-owned credentials via `carrier_credential`) is between the tenant and FedEx. Pharmax's relationship is through EasyPost as the aggregator. Confirm at annual review that no direct Pharmax-FedEx data flow has emerged. |
| **UPS** <a id="ups"></a>                                   | [BAA status: TBD] | [BAA effective date: TBD] | [BAA review date: TBD] | CTO   | Same posture as FedEx — direct UPS engagement is tenant-owned; Pharmax routes through EasyPost.                                                                                                                                                         |
| **Sentry** <a id="sentry"></a>                             | [BAA status: TBD] | [BAA effective date: TBD] | [BAA review date: TBD] | CTO   | Sentry receives only redacted contexts per `../OBSERVABILITY.md` §"Layer 2 — Sentry". BAA procured as a belt-and-braces measure. Evidence: `evidence/baa/sentry/<YYYY-MM>-baa-executed.pdf`.                                                            |
| **Datadog or Honeycomb** <a id="datadog-or-honeycomb"></a> | [BAA status: TBD] | [BAA effective date: TBD] | [BAA review date: TBD] | CTO   | Vendor selection pending. The vendor chosen must offer a BAA. Until selection, the tracker row is a placeholder.                                                                                                                                        |
| **GitHub** <a id="github"></a>                             | N/A — not a BA    | n/a                       | [BAA review date: TBD] | CTO   | No PHI in source repositories. Test fixtures use synthetic data only. Confirm at annual review.                                                                                                                                                         |
| **Vercel** <a id="vercel"></a>                             | [BAA status: TBD] | [BAA effective date: TBD] | [BAA review date: TBD] | CTO   | Applicable only if `apps/web` is deployed on Vercel. Vercel publishes a BAA on Enterprise plans. Update status when deployment target is finalized.                                                                                                     |
| **Resend** <a id="resend"></a>                             | [BAA status: TBD] | [BAA effective date: TBD] | [BAA review date: TBD] | CTO   | Required if Resend is used for patient-facing notifications that include identifying information. Resend offers a BAA on certain plans. Evidence: `evidence/baa/resend/<YYYY-MM>-baa-executed.pdf`.                                                     |
| **1Password** <a id="1password"></a>                       | N/A — not a BA    | n/a                       | [BAA review date: TBD] | CTO   | 1Password holds Pharmax employee credentials, not PHI. Confirm at annual review that no PHI is being stored as attachments.                                                                                                                             |

## Workflow

The BAA workflow per vendor follows [Vendor Management Policy](../policies/vendor-management-policy.md) §3.3:

1. Vendor identified as PHI-touching during onboarding (or during a re-evaluation triggered by a design change).
2. BAA request initiated with the vendor's procurement / legal team. Status: `requested`.
3. Terms reviewed by Pharmax's CTO and (where engaged) legal counsel.
4. BAA executed by both parties. Status: `executed`. PDF filed under `evidence/baa/<vendor>/<YYYY-MM>-baa-executed.pdf`.
5. Engineering switch for PHI flow may be turned **on** only after status flips to `executed`.
6. The `BAA review date` field is set to the next annual review point (typically 12 months from execution or earlier per vendor cadence).

At termination ([Vendor Management Policy](../policies/vendor-management-policy.md) §6):

1. Engineering switch flipped **off** to halt new PHI flows.
2. Return-or-destroy clause exercised per the BAA. Destruction certificate filed under `evidence/baa/<vendor>/<YYYY-MM>-destruction-cert.pdf`.
3. Status changed to `terminated`. The row stays in this tracker for the audit trail.

## Quarterly cross-reference check

During each quarterly access review ([`access-review-procedure.md`](./access-review-procedure.md)), the CTO cross-references:

- The active integration switches in the engineering codebase (environment variables, feature flags) against this tracker.
- Any integration switch that is **on** for PHI flow must point to a vendor with `BAA status: executed`.
- A discrepancy is an immediate finding and is escalated under [Incident Response Policy](../policies/incident-response-policy.md) §3 at SEV2 (PHI flowing without BAA is a compliance event regardless of whether actual disclosure has occurred).

## Cross-references

- [Vendor Management Policy](../policies/vendor-management-policy.md) — the procedural parent.
- [vendor-inventory.md](./vendor-inventory.md) — the full vendor list and data-flow notes.
- HIPAA 45 CFR § 164.308(b), § 164.314(a), § 164.504(e), § 164.410.
