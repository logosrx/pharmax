# Acceptable Use Policy

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

This Acceptable Use Policy ("AUP") states what people with credentials that touch Pharmax systems are expected to do, and what they are not allowed to do, on their devices and in their day-to-day work. It is the operational expression of the workforce-security clauses of the HIPAA Security Rule (45 CFR § 164.308(a)(3) — workforce security; 45 CFR § 164.308(a)(5) — security awareness and training) and the logical-access criteria of SOC 2 (CC6).

The AUP is short on purpose. The rules are absolute; the rationales are kept brief so the document remains a thing people actually read.

## 2. Scope

This policy applies to all Pharmax employees, contractors, and interns who hold credentials for any of:

- The Pharmax GitHub organization.
- The Pharmax AWS account(s).
- The Pharmax production or staging databases.
- The Pharmax Clerk dashboard.
- The Pharmax Stripe dashboard.
- The Pharmax EasyPost, FedEx, or UPS portals.
- The Pharmax 1Password vault.
- Any Pharmax operator-console deploy (web app), regardless of role.

It applies to every device used to access those systems, including personally-owned devices governed by §4. It applies during and outside of working hours; the credentials do not have a calendar.

## 3. Identity and credentials

### 3.1 No shared accounts

Every account is owned by exactly one human. There are no shared logins for any system, internal or vendor. If a vendor portal lacks per-user accounts, the team escalates to find a replacement vendor or accepts a single named owner whose use is recorded in the [access-review procedure](../governance/access-review-procedure.md).

Workstation print agents, scheduled workers, and webhook services use **system identities** (e.g. `shipping-webhook@*`, `print-agent@*`) that are intentionally separated from human identities and never have an assigned `clerkUserId`. They are managed via service-account credentials in AWS Secrets Manager and do not consume MFA seats.

### 3.2 Password manager: 1Password is mandatory

All credentials used to access Pharmax systems must be stored in the Pharmax 1Password vault. This includes:

- SaaS account passwords.
- API tokens.
- SSH keys.
- AWS access keys (where unavoidable — see §3.4).
- Recovery codes for MFA-protected accounts.

The 1Password vault uses SSO sign-on tied to the company identity provider where supported, and a strong passphrase + hardware key fallback otherwise. Sharing a credential outside the vault (Slack DM, email, paste into a chat agent, screenshot) is a policy violation per §6.

### 3.3 MFA is mandatory where supported

Every account that supports multi-factor authentication is enrolled. Where the role is `BillingManager` or `OrgAdmin` inside Pharmax, MFA is enforced on the Clerk side — sign-in fails closed if the user does not present a second factor. See the [Access Control Policy](./access-control-policy.md) §4 for the per-role table.

Hardware security keys (YubiKey or equivalent) are preferred over TOTP for accounts that hold material privilege (AWS, GitHub org owner, Stripe owner, Clerk owner). TOTP is acceptable for everything else.

Push-only or SMS-based MFA is **not** acceptable for any account that holds privileged access. SMS is acceptable as a fallback recovery channel only.

### 3.4 No AWS root usage

The AWS root account credentials live exclusively in 1Password, are protected by a hardware MFA key, and are used only for the irreducible set of root-only operations (e.g. enabling an Organizations feature, closing the account). The everyday surface is IAM users with the minimum required permissions, or — preferred — AWS SSO federated roles.

Anyone caught using root credentials for routine work has a conversation with the CTO that day. This is not a step on the sanctions ladder; it is the most fixable possible violation, but it is also the one with the largest blast radius.

## 4. Device requirements

### 4.1 Full-disk encryption

Every device used to access Pharmax systems must have full-disk encryption enabled and verified:

- macOS: FileVault on, recovery key escrowed in 1Password under the personal owner's vault entry.
- Windows: BitLocker on with a TPM-backed key.
- Linux: LUKS on the root and home partitions.

A device that does not meet this requirement is not allowed to access Pharmax systems. If a device is lost or stolen, encryption is the difference between "report it and rotate credentials" and "report it as a breach under 45 CFR § 164.402 with notification obligations".

### 4.2 Lock screen and screen privacy

Auto-lock is set to no more than 5 minutes of inactivity. The lock screen requires the user's password or biometric. Working from a public space (coffee shop, coworking, airport) requires either a privacy filter on the screen or visual confirmation that no shoulder-surfer can read the screen.

The lock-screen rule applies whenever the operator console is visible. Patient names, prescription sigs, and addresses are PHI; a glance over the shoulder is a disclosure event.

### 4.3 Operating system and software currency

- The operating system runs the current major release, with security updates applied within 14 days of release.
- The browser is Chrome, Firefox, Edge, or Safari, current major release, auto-updates on.
- Antimalware: on Windows, Microsoft Defender (or equivalent) with current definitions. On macOS, the built-in protections (Gatekeeper, XProtect) plus the system update cadence.
- The team does not require MDM today because the team is small and we operate on trust + spot checks; an MDM enrollment will become mandatory once the team passes 15 engineers or whenever a customer contract requires it. The MDM-optional posture is recorded in the [risk register](../governance/risk-register.md).

### 4.4 No PHI on personal devices

PHI is never stored on a personal device. The operator console renders PHI on the screen during the session — that is in-process display, which is fine — but the user must not:

- Take a screenshot of a screen showing PHI.
- Copy/paste PHI into a personal note-taking app, a personal email, or a personal chat tool.
- Download a PDF or attachment containing PHI to the device's local disk and leave it there.
- Forward a Pharmax email containing PHI to a personal address.

If a workflow requires saving an attachment locally (rare — most workflows live in the console), the attachment is saved to a Pharmax-managed S3 bucket or a 1Password attachment slot, not to the local filesystem.

## 5. Network

### 5.1 TLS only

All access to Pharmax systems goes over TLS. The operator console refuses HTTP; the AWS, GitHub, Clerk, Stripe, EasyPost, and Datadog dashboards refuse HTTP. There is no acceptable scenario for a plaintext connection.

### 5.2 Public networks

Working from a public Wi-Fi network (coffee shop, hotel, airport) requires either:

- A trusted Pharmax-managed VPN connection.
- A trusted tethered mobile connection.

Open-public Wi-Fi without a VPN is acceptable only for read-only access to public Pharmax pages (marketing site, public documentation) and is not acceptable for any console, dashboard, or repo access.

### 5.3 Home networks

Home networks are not public networks; routine work from a reasonably configured home network (WPA2/WPA3, strong password, current firmware on the access point) is fine.

## 6. Prohibited uses

The following are policy violations. The severity scales with intent and impact per the [Information Security Policy](./information-security-policy.md) §9.

### 6.1 PHI in unstructured channels — never

- No PHI in Slack messages.
- No PHI in email.
- No PHI in chat with AI assistants (see §7).
- No PHI in support tickets to vendors.
- No PHI in GitHub issues, PR descriptions, or commit messages.
- No PHI in screenshots, screen recordings, or video conference shares.
- No PHI in personal note-taking tools.

The operator console is the channel for PHI. Everywhere else is `[Patient ID]` or `[Order ID]` or `[Patient initials redacted]`. The product enforces this on the engineering side (the Pino redactor + Sentry allowlist in `../OBSERVABILITY.md`); humans are responsible for it everywhere else.

### 6.2 Credential sharing — never

- No sending an API token in Slack.
- No reading a password aloud on a Zoom call.
- No "I'll just text you the recovery code".
- No sharing a 1Password vault entry by URL.

Credentials transit via the 1Password vault's share mechanism, with the recipient's vault as the destination, expiring as soon as the recipient has stored their own copy.

### 6.3 Unauthorized data export

- No downloading a tenant's data outside of the documented export workflows.
- No `pg_dump` against the production database from a personal machine.
- No bulk query of `patient`, `order`, or any PHI-bearing table without a documented business purpose and audit trail.

The patient-search workflows are deliberately narrow (blind-index lookups per ADR 0010; never decrypted scans). If you find yourself wanting to "just grab a list" of patients, you are about to commit a policy violation; stop, document the need, and route through the access-review process.

### 6.4 Bypassing the command bus

The command bus is the audit-and-safety system. Bypassing it — for example, `prisma.order.update({ where: { id }, data: { current_status: '...' } })` — is a critical violation per `.cursor/rules/01-workflow-safety.mdc` and the [Change Management Policy](./change-management-policy.md). The runbook is explicit: even in an incident, the command bus is the path.

### 6.5 Production data in development

No production PHI, no production secrets, and no production database snapshots in a development environment. Local development uses synthetic data only (the `bootstrap-org` seed fixtures, the `LocalKmsAdapter` for envelope encryption, fake Stripe events via `stripe trigger`).

A developer who needs to reproduce a production data shape requests a **shape-only** fixture: schema and row counts but with all PHI fields replaced by synthetic values. Bulk copying production into staging is forbidden; staging is provisioned from `bootstrap-org` like local dev.

## 7. AI tool usage

AI assistants — coding agents in the IDE, generic chat tools, vendor-side AI features — are accelerators when used within their lane and a category of data leak when used outside it. The rules:

### 7.1 No PHI in prompts

Do not paste patient names, dates of birth, addresses, prescription sigs, MRNs, or any other PHI into any AI tool prompt. This includes:

- IDE-embedded assistants when the file open on screen contains PHI (e.g. a script that hits a PHI-containing table). Redact before invoking the assistant.
- Chat agents (ChatGPT, Claude, Gemini, etc.) for help debugging an issue. The redaction rule is the same as for support tickets: `[Patient ID]`, `[Order ID]`, no plaintext.
- AI features inside vendor dashboards (Datadog AI, GitHub Copilot Chat, AWS Q, etc.) where the conversation may include log lines, query results, or stack traces that contain PHI.

The defense is the same as for logs: the AI tool is an untrusted channel for PHI, full stop.

### 7.2 No secrets in prompts

Same rule as §6.2. Do not paste an API token, password, or KMS material into a prompt. AI tools may store or log prompt content; assume any prompt is permanent.

### 7.3 No customer-tenant data without authorization

When asking an AI tool a question about a real customer issue, redact tenant identifiers. The customer's `organizationId` is internal, not Restricted, but it leaks tenant identity if disclosed; treat it as Confidential and redact before exposing to a vendor AI.

### 7.4 Output is unverified

AI-generated code is reviewed like any other change. The [Change Management Policy](./change-management-policy.md) §3 requires a human reviewer regardless of who or what wrote the change. AI-generated text in customer communications is reviewed by a human before sending.

### 7.5 Allowed uses

These are fine and encouraged:

- Asking an AI to explain a concept, refactor a function, generate boilerplate, or draft a regex.
- Using an in-IDE assistant on code that does not have PHI open.
- Asking an AI to help draft this kind of policy document.
- Using vendor AI features against synthetic or aggregated data.

## 8. Data handling summary

The [Data Classification Policy](./data-classification.md) is the source of truth. The one-line summary for daily use:

- **Public** — fine in any channel, fine to publish.
- **Internal** — fine inside the team, not for public sharing.
- **Confidential** — internal share with named recipients only, never on a personal device, never in an AI prompt.
- **Restricted / PHI** — operator console and PHI-cleared backends only. Never in any other channel.

When in doubt about a classification, ask the CTO. The cost of one Slack message is much less than the cost of a misclassification incident.

## 9. Reporting violations and suspected incidents

If you suspect a violation of this AUP — your own, a coworker's, or an external party's — report it under the [Incident Response Policy](./incident-response-policy.md). The escalation paths are:

- A suspected PHI exposure: pages on-call immediately. Treat as SEV0 until classified.
- A lost or stolen device: notify the CTO and the on-call engineer the same day; rotate the affected credentials per the runbook.
- A credential-sharing slip-up (you sent a token in Slack): edit out the token, notify the CTO, rotate the token, document in the incident channel.
- An AUP violation observed in another person's behavior: raise to the CTO directly. Pharmax operates a no-retaliation posture; honest reporting is always the correct action.

The point of reporting is the system, not the person. Per the [Incident Response Policy](./incident-response-policy.md), postmortems are blameless and the system is what gets fixed.

## 10. Acknowledgment

Every employee, contractor, and intern signs an acknowledgment that they have read and understood this AUP:

- At onboarding, before being granted access to any Pharmax system.
- At the annual security training cycle ([`../governance/security-training-program.md`](../governance/security-training-program.md)).
- Whenever a material change to this AUP is published (re-signature within 30 days).

Signed acknowledgments are filed under `evidence/training/<year>/aup-acknowledgments.csv`.

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
