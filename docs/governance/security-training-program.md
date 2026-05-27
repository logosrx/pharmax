# Security and HIPAA Training Program

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

This document describes the Pharmax security and HIPAA training program — who is trained, on what, how often, on which platform, and how completion is tracked. The program is the operational mechanism behind the workforce-security commitments in the [Information Security Policy](../policies/information-security-policy.md) §4 and the [Acceptable Use Policy](../policies/acceptable-use-policy.md) §10.

This maps to:

- SOC 2 **CC1.4** — commitment to attract, develop, and retain competent individuals.
- SOC 2 **CC2.2** — internal communications (including training).
- HIPAA **45 CFR § 164.308(a)(5)** — security awareness and training. The implementation specifications under this standard (security reminders, protection from malicious software, log-in monitoring, password management) are folded into the curriculum below.

## 2. Audience and assignment

Training is assigned to every person with access to Pharmax systems, regardless of role or employment status:

- **Employees** — full-time and part-time.
- **Contractors and consultants** — for the duration of the engagement.
- **Interns** — same as employees.
- **System-identity owners** — the human who owns a `WebhookService` or print-agent service identity (not the service itself, obviously).

Assignment is mandatory; non-completion is a control failure that escalates per §7.

## 3. Curriculum

Training is delivered via a security and compliance training platform (today our intended vendor is Vanta or equivalent — see §5). The curriculum modules:

### 3.1 Core security awareness — mandatory annual

| Module                          | Length  | Why we require it                                                                                                                                                                                                                          |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Information security overview   | ~20 min | Establishes the program, the risks, the role of the workforce.                                                                                                                                                                             |
| Phishing and social engineering | ~20 min | The most common attack vector. Includes phishing-resistant MFA orientation for privileged users.                                                                                                                                           |
| Password and credential hygiene | ~15 min | Reinforces the 1Password-mandatory, no-shared-accounts, MFA-everywhere posture from [Acceptable Use Policy](../policies/acceptable-use-policy.md) §3.                                                                                      |
| Device security                 | ~15 min | Reinforces the encryption / lock-screen / OS-current / no-PHI-on-device rules from [Acceptable Use Policy](../policies/acceptable-use-policy.md) §4.                                                                                       |
| Incident reporting              | ~10 min | What to do when you see or suspect something. Reinforces the no-blame, report-first posture from [Acceptable Use Policy](../policies/acceptable-use-policy.md) §9 and [Incident Response Policy](../policies/incident-response-policy.md). |
| AI tool usage                   | ~10 min | No PHI in prompts, no secrets in prompts, output is unverified. Reinforces [Acceptable Use Policy](../policies/acceptable-use-policy.md) §7.                                                                                               |

### 3.2 HIPAA awareness — mandatory annual

| Module                                               | Length  | Why we require it                                                                                                                                                                                                 |
| ---------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIPAA overview and definitions                       | ~25 min | Covers PHI definition, Covered Entity vs Business Associate, Privacy Rule highlights, Security Rule highlights.                                                                                                   |
| The HIPAA Security Rule (45 CFR Part 164, Subpart C) | ~30 min | Administrative, physical, technical safeguards. Maps to Pharmax-specific controls (envelope encryption, RLS, audit chain, access control). The Pharmax-specific overlay is delivered in-house (see §3.4).         |
| Minimum necessary standard                           | ~15 min | Treats every disclosure as "smallest amount that does the job". Connects to the patient-search workflow (blind-index, narrow), the notification-template content guidance, and the support-channel PHI-free rule. |
| Breach notification expectations                     | ~15 min | What the Breach Notification Rule (45 CFR §§ 164.404–410) requires, why our internal target of 24-hour customer notification beats the 60-day statutory floor.                                                    |

### 3.3 Role-specific modules

| Module                                   | Audience                                                                                                        | Length  | Why                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secure coding for healthcare engineering | Engineers                                                                                                       | ~45 min | OWASP basics + Pharmax-specific anti-patterns (no bypassing the bus, no broad PHI scans, no PHI in logs). Cross-references `../ARCHITECTURE_PRINCIPLES.md`. |
| Pharmacy workflow safety                 | Engineers, especially anyone touching `packages/orders`, `packages/verification`, `packages/workflow`           | ~30 min | `.cursor/rules/01-workflow-safety.mdc` walkthrough — no fill before PV1, no final before fill, no ship before final, audit trail invariants.                |
| Database safety and RLS                  | Engineers                                                                                                       | ~30 min | ADR 0004 walkthrough — the two-layer wall, the `pharmax_system` discipline, the migration linter's role.                                                    |
| Envelope encryption and PHI handling     | Engineers touching `packages/crypto`, `packages/patients`, or any new PHI-bearing model                         | ~30 min | ADR 0005 + ADR 0010 walkthrough — envelope, AAD binding, blind-index, crypto-shred.                                                                         |
| Privileged-access etiquette              | Anyone with AWS root, AWS Organization, GitHub org-owner, Clerk admin, Stripe live owner, `pharmax_system` role | ~20 min | Walks through the privileged-access list from [Access Control Policy](../policies/access-control-policy.md) §9 and the audit/breakglass expectations.       |
| Billing-data handling                    | `BillingManager` operators, billing engineers                                                                   | ~20 min | The Stripe-as-not-a-BA design rationale, the invoice-description restriction, the refund process.                                                           |

### 3.4 In-house Pharmax-specific overlay

Two of the modules above are delivered in-house rather than via the vendor platform because they are too specific to our architecture for a generic training catalog:

- **Pharmacy workflow safety**.
- **Database safety and RLS** + **Envelope encryption and PHI handling**.

These are 30-minute walkthrough sessions, recorded for asynchronous viewing and re-watch. The recordings are stored under `evidence/training/<year>/recordings/`. The session leader is the CTO; once the team grows, the workflow-engine owner and the crypto package owner lead their respective modules.

## 4. Cadence

| Event                                                         | Modules due                                                                   | Deadline                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Onboarding (Day 1)                                            | [Acceptable Use Policy](../policies/acceptable-use-policy.md) acknowledgment. | Day 1, before any system access.                                                     |
| Onboarding (Week 1)                                           | All §3.1 core security modules, all §3.2 HIPAA modules.                       | End of Week 1.                                                                       |
| Onboarding (Month 1)                                          | All §3.3 role-specific modules for the assigned role.                         | End of Month 1.                                                                      |
| Annual refresh                                                | All §3.1 + §3.2 modules.                                                      | Annual anniversary of onboarding, or by Dec 31 of each year — whichever comes first. |
| Material policy change                                        | The affected policy's acknowledgment.                                         | 30 days from the policy publication.                                                 |
| Role change                                                   | The new role's §3.3 modules.                                                  | 30 days from the role change.                                                        |
| Post-incident, where the postmortem identifies a training gap | The targeted module + a postmortem-specific briefing.                         | 30 days from the postmortem.                                                         |

The annual refresh is timed against either the individual's onboarding anniversary or a single end-of-year cycle for the whole team — the choice is a per-employee preference, with the default being end-of-year so the team aligns on a single refresh window.

## 5. Platform

Today the intended platform is **[Vanta]** (or equivalent — Drata, Tugboat Logic, Secureframe; the selection is a procurement decision that follows the [Vendor Management Policy](../policies/vendor-management-policy.md)). The platform's role:

- Hosts the §3.1 and §3.2 modules with verified content.
- Issues and tracks per-user assignments.
- Generates completion certificates and reminders.
- Integrates with the company identity provider so attempted access by an out-of-compliance user is detectable.

Pharmax-specific overlays (§3.4) are recorded internally and tracked through the same platform's "custom content" feature where supported, or via a parallel attestation tracked manually under `evidence/training/<year>/` until the platform supports them natively.

If the selected platform changes, this section is updated and the migration of in-flight assignments is recorded in the next quarterly access review.

## 6. Tracking and evidence

Per-user completion is tracked in the training platform. The exported records are filed under `evidence/training/<year>/`:

- `acknowledgments.csv` — Acceptable Use Policy and other policy acknowledgments.
- `core-security-completion.csv` — §3.1 module completion per user, per cycle.
- `hipaa-awareness-completion.csv` — §3.2 module completion per user, per cycle.
- `role-specific-completion.csv` — §3.3 module completion per user, per assigned module.
- `recordings/` — internally-recorded §3.4 sessions.
- `certificates/<user>/` — individual PDF certificates issued by the platform.

The CTO confirms completion at the close of each annual cycle and again at each quarterly access review (training non-completion shows up in the access review).

## 7. Non-completion handling

A user who has not completed assigned training by the deadline is in violation of this program. The escalation:

1. **Day 0** — deadline passed. Automated reminder to the user, copy to the CTO.
2. **Day +7** — direct outreach from the CTO with a target completion date. The user's manager (where applicable) is informed.
3. **Day +14** — access reduction. The user's role permissions are reduced to "no PHI access" until completion. This is enforced via the [Access Control Policy](../policies/access-control-policy.md) override mechanism (the override grants a restricted permission set with an expiration tied to completion).
4. **Day +30** — escalation to the CEO. The user's continued access to Pharmax systems is reviewed.

The escalation path is not punitive in intent; it is the system response to a control failure. The user's manager is responsible for clearing schedule space if training is the blocker.

## 8. Effectiveness review

The training program is itself reviewed annually:

- The CTO reviews completion rates and time-to-completion.
- The CTO reviews the postmortem record for incidents that suggest a training gap.
- The CTO reviews the curriculum against any material change in the architecture, the regulatory landscape, or the vendor stack.
- Module content is refreshed where it has aged out of relevance.

Review outputs go into the annual risk-assessment exercise ([`risk-assessment-procedure.md`](./risk-assessment-procedure.md)) and any necessary updates are committed back to this document.

## 9. Cross-references

- [Information Security Policy](../policies/information-security-policy.md) — parent.
- [Acceptable Use Policy](../policies/acceptable-use-policy.md) — what the training reinforces.
- [Access Control Policy](../policies/access-control-policy.md) — the override mechanism used in §7 escalation.
- [Incident Response Policy](../policies/incident-response-policy.md) — incidents may identify training gaps.
- [`access-review-procedure.md`](./access-review-procedure.md) — training completion is a check.
- HIPAA 45 CFR § 164.308(a)(5).
- SOC 2 CC1.4, CC2.2.

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
