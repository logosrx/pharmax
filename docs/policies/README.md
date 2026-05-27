# Pharmax policies

Authoritative, signed, reviewed policy documents for the Pharmax enterprise pharmacy operating system. These complement — they do not replace — the engineering runbooks (`../RUNBOOK.md`, `../INCIDENT_RESPONSE.md`, `../OBSERVABILITY.md`) and the architectural record (`../ARCHITECTURE.md`, `../ARCHITECTURE_PRINCIPLES.md`, `../adr/`).

The policies are written for two audiences in roughly equal weight:

1. **Internal practitioners** — engineers, ops staff, and leadership who need to know what they're expected to do and what they're not allowed to do.
2. **External reviewers** — SOC 2 auditors, HIPAA-readiness assessors, procurement security reviewers, and prospective customers.

We deliberately keep policy and engineering documentation close together. Drift between "what the policy says" and "what the system does" is the failure mode this bundle is designed to prevent.

## Header convention

Every policy in this directory begins with the same front-matter block:

```markdown
| Field          | Value                       |
| -------------- | --------------------------- |
| Owner          | [Owner: CTO]                |
| Approver       | [Approver: CEO]             |
| Effective date | [Effective date: TBD]       |
| Last reviewed  | [Last reviewed: YYYY-MM-DD] |
| Next review    | [Next review: YYYY-MM-DD]   |
| Version        | 0.1                         |
| Distribution   | Internal — All staff        |
```

And ends with a revision-history table:

```markdown
## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
```

Cadence defaults — unless a specific policy overrides them:

- **Review cadence:** annual, plus any time a material control changes (new vendor with PHI access, new sub-processor, change in regulatory posture, change in the modular monolith's blast-radius boundaries).
- **Approval authority:** CEO. The CTO is accountable owner; the CEO is the formal approver.
- **Distribution:** Internal — All staff. Versions intended for external sharing (procurement, audit) are exported on request and marked `External` in the distribution row.
- **Storage of evidence:** signed PDFs, training certificates, access-review attestations, and BAA executions live under `evidence/` (gitignored — references only in this repo). Source-of-truth markdown is in this directory.

## The bundle

### Top-level

- [`information-security-policy.md`](./information-security-policy.md) — the umbrella ISP. Defines the security program, roles, and links into every other policy.

### Operational

- [`acceptable-use-policy.md`](./acceptable-use-policy.md) — what humans with access to Pharmax may and may not do with company devices, credentials, and AI tooling.
- [`data-classification.md`](./data-classification.md) — the four data tiers (Public, Internal, Confidential, Restricted/PHI) and the handling rules per tier.
- [`access-control-policy.md`](./access-control-policy.md) — identity, MFA, RBAC, tenancy isolation, break-glass, quarterly access reviews.
- [`change-management-policy.md`](./change-management-policy.md) — branch / PR / CI / review / deploy / rollback. The policy frame on top of the runbook's mechanics.

### Vendor, incident, continuity

- [`vendor-management-policy.md`](./vendor-management-policy.md) — vendor onboarding, security review, BAA requirements, annual re-review, decommissioning.
- [`incident-response-policy.md`](./incident-response-policy.md) — policy frame on top of `../INCIDENT_RESPONSE.md`. Classification authority, communications tree, regulatory notification obligations, postmortem and drill cadence.
- [`business-continuity-and-disaster-recovery.md`](./business-continuity-and-disaster-recovery.md) — RTO, RPO, critical functions, failover scenarios, drill cadence.

## Related governance and security artifacts

The policies above are the **what** and the **why**. Two sibling directories hold the **who**, the **when**, and the **how**:

- [`../governance/`](../governance/) — risk register, risk-assessment procedure, vendor inventory, BAA tracker, access-review procedure, security training program.
- [`../security/`](../security/) — HIPAA Security Risk Analysis, SOC 2 + HIPAA control matrix, data-flow diagram, secrets management posture, encryption overview.

## Exception process

Policy exceptions are rare and always documented. To request one:

1. Open a ticket against the policy file (link the specific section).
2. Describe the proposed exception, the duration, and the compensating controls.
3. CTO reviews; CEO approves anything that materially changes the security posture.
4. The signed exception is recorded under `evidence/exceptions/<YYYY-Q#>/` with the policy file and section referenced.
5. Exceptions expire by default at 90 days unless explicitly extended in writing.

Undocumented deviations from policy are treated as control failures and are recorded in the [risk register](../governance/risk-register.md).
