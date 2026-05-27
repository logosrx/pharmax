# Acceptable Use Policy — STUB

> **THIS IS A STUB.** Authoritative version:
> [`../../policies/acceptable-use-policy.md`](../../policies/acceptable-use-policy.md).
> Every `<TBD>` marker must be resolved by legal counsel and/or the
> SOC 2 auditor.

| Field          | Value                |
| -------------- | -------------------- |
| Owner          | Workforce Lead       |
| Approver       | CEO                  |
| Effective date | `<TBD>`              |
| Last reviewed  | `<TBD>`              |
| Next review    | `<TBD>`              |
| Version        | 0.1-stub             |
| Distribution   | Internal — All staff |

## 1. Purpose

Define the rules of acceptable behavior for any human using Pharmax
systems, devices, credentials, or AI tooling.

## 2. Scope

All Pharmax workforce (employees, contractors, contingent workers)
and any third-party human with credentialed access.

## 3. Policy statements

### 3.1 Device hygiene

- Workstations used for Pharmax work require:
  - Full-disk encryption.
  - Antimalware (`<TBD by legal counsel: specific products approved>`).
  - Auto-lock within `<TBD: 5 or 10 minutes>` of inactivity.
  - OS auto-updates enabled.
- Personal devices may access Pharmax services only through approved
  thin clients (e.g. Clerk-authenticated browser session); no PHI is
  stored locally.

### 3.2 Credential hygiene

- All Pharmax credentials live in the approved password manager
  (1Password).
- No credential sharing.
- No credential storage in code, logs, screenshots, prompts, chats, or
  AI tool inputs.
- Workforce-issued API keys are subject to rotation per the secrets
  management posture
  ([`../../security/secrets-management.md`](../../security/secrets-management.md)).

### 3.3 Communications

- Sensitive customer or PHI-adjacent discussion occurs only in
  Pharmax-approved channels (Slack workspace, email on company
  domain).
- No PHI in screenshots, public Slack channels, or social media.

### 3.4 AI tooling

`<TBD by SOC 2 auditor: explicit posture on AI assistants — which
tools are approved, what data may be sent (no PHI ever), what data may
not (any source code touching auth/crypto/audit goes to approved
enterprise instances only).>`

### 3.5 Travel and remote work

- Pharmax services may be accessed from secured networks only;
  airport / café Wi-Fi requires a VPN.
- Travel device hygiene per `<TBD by legal counsel: travel posture for
high-risk jurisdictions>`.

### 3.6 Reporting

Employees who observe a policy violation, a security weakness, or a
suspected incident report through the documented channel
(`security@<pharmax-domain>` or a Slack `/report` shortcut) without
fear of retaliation.

## 4. Roles and responsibilities

| Role             | Responsibility                                                          |
| ---------------- | ----------------------------------------------------------------------- |
| Workforce Lead   | Owns the policy; collects acknowledgments on hire and on annual review. |
| All workforce    | Acknowledges the policy on hire; re-acknowledges annually.              |
| Security Officer | Investigates reported violations.                                       |
| CEO              | Final sanctions decision.                                               |

## 5. Enforcement and sanctions

`<TBD by legal counsel: progressive-discipline schedule, escalation
to immediate termination for willful PHI mishandling or credential
misuse, and any criminal-referral language.>`

## 6. Review cadence

Annual.

## 7. References

- [`../../security/secrets-management.md`](../../security/secrets-management.md).
- [`information-security.md`](./information-security.md).
- [`data-classification.md`](./data-classification.md).

## 8. Revision history

| Version  | Date    | Author      | Change                  |
| -------- | ------- | ----------- | ----------------------- |
| 0.1-stub | `<TBD>` | Engineering | Initial framework stub. |
