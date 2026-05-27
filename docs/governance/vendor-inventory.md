# Vendor Inventory

| Field          | Value                       |
| -------------- | --------------------------- |
| Owner          | [Owner: CTO]                |
| Approver       | [Approver: CEO]             |
| Effective date | [Effective date: TBD]       |
| Last reviewed  | [Last reviewed: YYYY-MM-DD] |
| Next review    | [Next review: YYYY-MM-DD]   |
| Version        | 0.1                         |
| Distribution   | Internal — All staff        |

This is the standing inventory of third-party vendors that store, process, transmit, or have administrative access to Pharmax data. It is maintained per the [Vendor Management Policy](../policies/vendor-management-policy.md). BAA execution status per HIPAA-covered vendor is tracked separately in [`baa-tracker.md`](./baa-tracker.md).

Vendor "category" buckets:

- **Infrastructure** — compute, storage, KMS, secrets, observability primitives.
- **Identity** — authentication, identity provider.
- **Payments** — payment processor, reconciliation.
- **Shipping** — carrier and label aggregator.
- **Observability** — application performance monitoring, error tracking, log aggregation.
- **Communications** — transactional email, notifications.
- **Source code & CI** — code hosting, deploy pipeline.
- **Workforce tooling** — password manager, document storage, productivity.

A vendor that touches PHI requires a Business Associate Agreement before any data flows. A vendor that does not touch PHI but holds Pharmax credentials or systems administration access is `BAA required: N/A` and is governed by the master services agreement and any data-processing addendum.

## Inventory

| Vendor                             | Category                       | Data accessed                                                                                  | PHI?                                                       | BAA required                      | BAA status (see [tracker](./baa-tracker.md))     | SOC 2 on file                             | Contract URL        | Owner | Last review                 |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------- | ------------------------------------------------ | ----------------------------------------- | ------------------- | ----- | --------------------------- |
| **AWS** (RDS)                      | Infrastructure                 | Production PostgreSQL — envelope-encrypted PHI ciphertexts; tenant-scoped operational data     | Yes (ciphertext)                                           | Yes                               | [tracker](./baa-tracker.md#aws)                  | Yes (annual)                              | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **AWS** (S3)                       | Infrastructure                 | Documents, scans, labels, attachments; tenant-scoped                                           | Yes                                                        | Yes                               | [tracker](./baa-tracker.md#aws)                  | Yes (annual)                              | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **AWS** (KMS)                      | Infrastructure                 | Per-tenant KEK material; envelope key wrapping                                                 | Yes (key custody)                                          | Yes                               | [tracker](./baa-tracker.md#aws)                  | Yes (annual)                              | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **AWS** (ECS / Fargate)            | Infrastructure                 | Compute for `apps/web`, `apps/worker`; PHI in process memory during request handling           | Yes (transient)                                            | Yes                               | [tracker](./baa-tracker.md#aws)                  | Yes (annual)                              | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **AWS** (Secrets Manager)          | Infrastructure                 | Runtime secrets (DB credentials, KMS key references, vendor API keys)                          | No (secrets only)                                          | Yes                               | [tracker](./baa-tracker.md#aws)                  | Yes (annual)                              | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **AWS** (CloudWatch)               | Infrastructure / Observability | Application logs (PHI-redacted), CloudTrail audit logs                                         | No (redacted)                                              | Yes                               | [tracker](./baa-tracker.md#aws)                  | Yes (annual)                              | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **Clerk**                          | Identity                       | Operator identity, email, MFA factors, session metadata                                        | No (PII; not PHI by HIPAA definition for our use)          | Yes (PII handling)                | [tracker](./baa-tracker.md#clerk)                | Yes                                       | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **Stripe**                         | Payments                       | Customer (clinic) billing identity, invoice line items, payment-method tokens; not patient PHI | No (per BAA-out design)                                    | N/A (out of PHI scope by design)  | [tracker](./baa-tracker.md#stripe)               | Yes                                       | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **EasyPost**                       | Shipping                       | Per-shipment addressee + sender; recipient address is PHI by HIPAA definition (linkage)        | Yes                                                        | Yes                               | [tracker](./baa-tracker.md#easypost)             | Yes (review on file)                      | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **FedEx**                          | Shipping                       | Shipment manifest data, recipient address                                                      | Yes                                                        | Yes                               | [tracker](./baa-tracker.md#fedex)                | N/A (carrier — pending policy assessment) | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **UPS**                            | Shipping                       | Shipment manifest data, recipient address                                                      | Yes                                                        | Yes                               | [tracker](./baa-tracker.md#ups)                  | N/A (carrier — pending policy assessment) | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **Sentry**                         | Observability                  | Application errors with stack traces; redacted via `beforeSend` allowlist                      | No (redacted)                                              | Yes (allowlist guarantees no PHI) | [tracker](./baa-tracker.md#sentry)               | Yes                                       | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **Datadog** or **Honeycomb** (TBD) | Observability                  | Application logs / traces (redacted), metrics                                                  | No (redacted)                                              | Yes (pending vendor selection)    | [tracker](./baa-tracker.md#datadog-or-honeycomb) | Yes (per vendor)                          | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **GitHub**                         | Source code & CI               | Pharmax source repository (Confidential), CI workflows; no PHI                                 | No                                                         | N/A                               | [tracker](./baa-tracker.md#github)               | Yes                                       | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **Vercel** (if deployed)           | Infrastructure                 | If `apps/web` is hosted on Vercel: edge / serverless runtime for the operator console          | Yes (if used)                                              | Yes (if used)                     | [tracker](./baa-tracker.md#vercel)               | Yes                                       | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **pnpm registry / npm**            | Source code & CI               | Open-source package downloads; supply-chain dependency                                         | No                                                         | N/A                               | n/a (open-source ecosystem)                      | n/a                                       | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **Resend** (if used)               | Communications                 | Transactional email recipient address and template content                                     | Yes (if patient-facing templates include identifying info) | Yes (if used)                     | [tracker](./baa-tracker.md#resend)               | Yes                                       | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |
| **1Password**                      | Workforce tooling              | Pharmax employee credentials                                                                   | No                                                         | N/A                               | [tracker](./baa-tracker.md#1password)            | Yes                                       | [Contract URL: TBD] | CTO   | [Last reviewed: YYYY-MM-DD] |

## Notes on specific entries

### AWS (treated as one vendor for BAA purposes)

AWS executes a single BAA covering the HIPAA-eligible services we use. The HIPAA Eligible Services list is published by AWS and reviewed annually; we confirm during the annual review that every AWS service we rely on for PHI handling is on the eligible list. Services on the eligible list as of policy drafting include RDS, S3, KMS, ECS / Fargate, Secrets Manager, CloudWatch Logs, CloudTrail.

### Clerk

Clerk holds operator identity — name, email, MFA factor metadata. Under HIPAA, this data is PII but is not patient PHI; however, an operator's identity tied to a workflow action is arguably patient-record-adjacent, and we operate as if a BAA is required. Confirm the Clerk BAA status in the tracker.

### Stripe — BAA scope

Stripe is intentionally **not** a Business Associate by design: Pharmax routes only customer (clinic) billing identity and invoice line items to Stripe. Patient-identifying information is not included in invoice descriptions or line-item descriptions. The `Invoice.lineItems[].description` field is required to be free of patient identifiers by convention; we enforce this in `packages/billing/` and the code-review process. If a future change requires sending patient-identifying invoice descriptions to Stripe, a BAA becomes required and the design is revisited.

### EasyPost, FedEx, UPS — recipient addresses are PHI

A recipient address tied to a pharmacy order is PHI under HIPAA because the linkage discloses that the named individual at that address received pharmacy services. We treat shipping carriers as PHI-touching vendors and require BAAs. For the major carriers (FedEx, UPS) the contract relationship is typically through EasyPost as a label aggregator; the BAA is with EasyPost and EasyPost's contracts cover the downstream carrier disclosure. Direct FedEx / UPS account engagements (per-tenant carrier credentials in `carrier_credential`) require the tenant's own carrier BAA where applicable; Pharmax does not interpose itself in that relationship.

### Sentry — redaction posture

Sentry receives only redacted contexts via the `beforeSend` allowlist documented in `../OBSERVABILITY.md` §"Layer 2 — Sentry". The redaction is a hard contract: we treat Sentry as a non-PHI processor on the basis that no PHI is transmitted. The BAA is procured anyway as a belt-and-braces measure and to support customer procurement reviews.

### Observability vendor selection

Datadog or Honeycomb is a placeholder until the observability stack outside Sentry is finalized. The selection requires:

- SOC 2 Type 2 report.
- BAA on offer (if any PHI is in scope; we expect the redacted-only posture from Sentry to apply here as well).
- US-region data residency.
- Stable retention controls (we want the option to set short retention on certain log streams).

The selection is tracked as an engineering item; the inventory row will be updated when the choice is finalized.

### Resend

Resend (or equivalent transactional email provider) sends patient-facing notifications. The notification templates are deliberately minimum-necessary: order reference and order status, not full PHI. Where a notification includes the patient's name (e.g. "Your order is ready"), the recipient email address and the name in the template are sent to Resend; that meets the HIPAA definition of PHI by linkage. The BAA is required.

### Open-source dependencies (pnpm / npm)

Open-source package providers are not bilateral vendors with BAAs; they are governed by their licenses and by the dependency-CVE control. Engineering-side vetting is the [Change Management Policy](../policies/change-management-policy.md) §3.3 CI gates, not this inventory.

## Maintenance

The CTO refreshes this inventory:

- On every new vendor onboarding per [Vendor Management Policy](../policies/vendor-management-policy.md) §3.5.
- On every vendor decommissioning per [Vendor Management Policy](../policies/vendor-management-policy.md) §6.
- During the quarterly access review (the inventory is one input).
- During the annual risk assessment ([`risk-assessment-procedure.md`](./risk-assessment-procedure.md)).

A vendor not in this inventory is not approved for use with Pharmax data; engineering integrations against an undocumented vendor fail review under the [Change Management Policy](../policies/change-management-policy.md).
