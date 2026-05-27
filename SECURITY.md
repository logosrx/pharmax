# Pharmax Security Policy

Pharmax is an enterprise pharmacy operating system handling
Protected Health Information (PHI), patient contact data, prescription
workflow, and financial transactions. We take security reports
seriously and prioritize them above feature work.

This document covers:

1. How to report a vulnerability.
2. What we commit to in return.
3. What is in scope.
4. Safe-harbor terms for good-faith research.
5. How we coordinate disclosure.

If anything below conflicts with a signed Business Associate
Agreement (BAA) or Master Services Agreement (MSA), the executed
contract controls.

---

## 1. How to report

Send vulnerability reports to **security@pharmax.example** (replace
this placeholder with the live address before publishing). Prefer
encrypted email — our PGP public key is published at
`https://pharmax.example/.well-known/security.txt`.

Please include:

- A clear description of the issue and its impact.
- Steps to reproduce, ideally a minimal proof-of-concept.
- The version (commit SHA or release tag) on which you observed it.
- Whether the issue is publicly known and, if so, references.
- Your preferred handle and contact for follow-up coordination.

**Do not** open a public GitHub issue, post in our community
channels, or include the vulnerability in a normal pull request.

**Do not** include any actual patient data (PHI), real customer
data, or any data you do not own. If your reproduction requires
data, use synthetic fixtures or the `npm run seed` helpers in the
repository.

## 2. Our commitment

We commit to:

- Acknowledge your report within **2 business days**.
- Provide a triage assessment within **5 business days**, including
  severity rating (CVSS v3.1) and an initial remediation timeline.
- Keep you informed of progress at least every **10 business days**
  until the issue is resolved or formally closed.
- Credit you in the security advisory (if any) unless you prefer
  to remain anonymous.

For critical issues (CVSS 9.0+ or active exploitation), we will
respond within 24 hours and engage our incident response process.

## 3. Scope

### In scope

- Hosted Pharmax services (`*.pharmax.example`) accessed through
  documented user workflows.
- The Pharmax web application, worker, and print agent source code
  in this repository.
- Pharmax-controlled infrastructure as code (`infra/terraform/**`).
- Pharmax open-source workspace packages under `packages/**`.

### Out of scope

- Third-party services we integrate with (Clerk, Stripe, AWS,
  Sentry, Datadog, EasyPost, FedEx, UPS). Report those directly to
  the vendor. We will, however, coordinate with the vendor on your
  behalf if the issue is reproducible against a Pharmax-managed
  deployment.
- Findings that depend on physical access to an operator workstation,
  social engineering of a Pharmax employee, or a compromised
  third-party browser extension.
- Self-XSS, missing best-practice headers without a demonstrated
  exploit, missing rate-limit on read-only metadata endpoints,
  username enumeration on `/sign-in` (handled by Clerk).
- Denial-of-service attacks against shared infrastructure (please do
  not conduct stress tests against production).
- Findings in our public marketing site (separate repository).

### Particularly welcome

- Anything that breaks **tenant isolation** (cross-organization data
  leakage, RLS bypass, RBAC privilege escalation).
- Anything that exposes **PHI** outside an authorized access path
  (e.g. decrypted PHI in logs, in error responses, in an exported
  artefact).
- Workflow-state attacks: forcing an order through a transition the
  command bus is supposed to forbid (ship before final
  verification, assign a held lot, etc.).
- Audit-log tampering or hash-chain integrity issues.
- KMS key-handling issues (DEK leakage, wrap/unwrap defects,
  tenant-context confusion in `EncryptionContext`).
- Billing integrity (forced refund without disposition, replaying a
  Stripe webhook to double-credit, manipulating the invoice
  approval flow).

## 4. Safe harbor

We will not pursue legal action against researchers acting in good
faith who:

- Do their best to avoid privacy violations, data destruction, and
  service interruption.
- Limit testing to accounts and data they own or are explicitly
  authorized to test against.
- Do not exploit a vulnerability beyond the minimum proof-of-concept
  needed to demonstrate impact.
- Report the finding privately through the channel above before
  any public disclosure.
- Give us a reasonable window (see § 5) before public disclosure.

If you are uncertain whether your planned testing is safe, ask
first. We would much rather answer a question than pursue a report.

## 5. Coordinated disclosure timeline

Our default disclosure window is **90 days from the date we
acknowledge your report**. We may request an extension for issues
requiring coordinated multi-vendor fixes (e.g. shared dependency
CVEs). We will not unilaterally extend without explanation.

You are free to publish:

- After the fix is shipped to all affected customers, OR
- After the agreed disclosure window expires, OR
- Sooner with our written go-ahead.

We will coordinate the publication of any advisory we author so
your credit and disclosure timing match yours.

## 6. Bug bounty

Pharmax does not currently operate a paid bug bounty program. We
recognize this is an active discussion item; reach out via the
contact above if you have a research interest you would like to
formalize.

---

_Last reviewed: 2026-05-25._
