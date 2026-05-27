# Risk Assessment Procedure

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

This document is the standard operating procedure for how Pharmax performs the periodic risk-assessment exercise. It is the management-system mechanism that keeps [`risk-register.md`](./risk-register.md) honest and prevents the register from drifting into a snapshot that nobody updates.

The procedure maps to:

- HIPAA **45 CFR § 164.308(a)(1)(ii)(A)** — risk analysis.
- HIPAA **45 CFR § 164.308(a)(1)(ii)(B)** — risk management.
- SOC 2 **CC3 — Risk Assessment** (CC3.1 identifies risks, CC3.2 evaluates risks, CC3.3 considers fraud, CC3.4 identifies and assesses change).

The [HIPAA Security Risk Analysis](../security/hipaa-security-risk-analysis.md) is the deeper structured document that this procedure produces and refreshes; the risk register is the standing record this procedure maintains.

## 2. Cadence

- **Annual full assessment.** Once per calendar year. The default scheduling window is the second quarter (Q2) so the output informs the second-half planning cycle.
- **Post-incident assessment.** Following any SEV0 or SEV1 incident, the procedure is re-run against the scope of the incident — at minimum the affected risk entries are re-rated; in practice a SEV0 typically prompts a sweep of related entries.
- **Material change assessment.** Re-run when any of the following change:
  - The production architecture (e.g. multi-region rollout, new critical vendor, change in the database posture).
  - The regulatory scope (e.g. expansion into a state with stricter requirements, a new federal rule).
  - The team size or composition such that role separation changes.
  - The customer composition such that the data sensitivity profile changes (e.g. first customer above 100k patients).
- **Vendor-driven assessment.** Re-run for the affected entries when a vendor publishes a material security disclosure.

## 3. Inputs

The risk-assessment exercise is informed by — at minimum — the following inputs collected before the kick-off meeting:

1. **The current [`risk-register.md`](./risk-register.md).** The standing register is the baseline.
2. **Threat modeling per service.** For each of `apps/web`, `apps/worker`, `apps/print-agent`, and each `packages/*` with a security-relevant surface (`crypto`, `tenancy`, `audit`, `rbac`, `command-bus`), the owner walks the data flow and identifies threat scenarios. We use a lightweight STRIDE-style frame: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege. The output is a one-page-per-service threat note saved under `evidence/risk-assessment/<YYYY>/threat-models/`.
3. **Last 12 months of incidents and postmortems.** Pulled from `evidence/incidents/`. Each postmortem with a SEV0 / SEV1 / SEV2 classification is reviewed for risks that should be added or re-rated.
4. **Vendor reports and disclosures.** The most recent SOC 2 reports of Tier 1 vendors (AWS, Clerk, Stripe, EasyPost where applicable). Notable findings, qualified opinions, and bridge-letter gaps are surfaced.
5. **The [HIPAA Security Risk Analysis](../security/hipaa-security-risk-analysis.md)** from the previous cycle. The annual run produces an updated SRA; the prior version is the baseline.
6. **Penetration test results**, if any pen tests were conducted in the prior 12 months.
7. **The [control matrix](../security/control-matrix.md).** Controls newly added or removed in the prior year are reviewed for the risks they mitigate.
8. **The [vendor inventory](./vendor-inventory.md) and [BAA tracker](./baa-tracker.md).** Any new vendor that touched PHI in the prior year is reviewed against the relevant risks.
9. **The drill outputs.** Per [BCP/DR](../policies/business-continuity-and-disaster-recovery.md) §8, drills produce documented gaps; these feed the risk-assessment exercise.

## 4. Participants

The annual assessment is run as a working session, not a paper exercise. Participants:

- **CTO** — facilitator; signs off on the output.
- **CEO** — present for the final review and the prioritization decision; approves the output.
- **Lead engineers** per security-relevant domain (workflow engine, crypto, tenancy, audit, billing, shipping). For our current team size, this is most of the engineering org.
- **Legal counsel** — present for the regulatory-implications portion if engaged.
- **External auditor or HIPAA assessor** — invited as an observer for one session per year if the SOC 2 engagement or HIPAA-readiness assessment cycle aligns.

For post-incident or material-change assessments, participation may be narrower — only the CTO and the affected domain leads.

## 5. Procedure

### 5.1 Preparation (T-2 weeks)

1. CTO confirms the assessment date and notifies participants.
2. CTO ensures the threat-modeling inputs (§3.2) are scheduled and the per-service notes are ready 48 hours before the kick-off.
3. CTO pulls the last-12-months postmortem set into a working folder.
4. CTO confirms the prior SRA, prior register, and prior control matrix are at hand.

### 5.2 Kick-off and asset inventory (Day 1 morning)

Working session, ~2 hours. Outputs go into the working `risk-assessment-YYYY` document under `evidence/risk-assessment/<YYYY>/working/`.

1. **Re-confirm the asset inventory.** What systems hold PHI? What systems hold credentials? What vendors touch what data? The output is the high-level diagram that anchors the rest of the session and that gets refreshed in the SRA.
2. **Re-confirm tenancy and access boundaries.** Has anything changed since last year that should be re-evaluated against R-003 (RLS misconfig), R-007 (malicious insider), R-020 (sign-up exposure)?
3. **Re-confirm regulatory scope.** Are we still operating under the same HIPAA and state-law footprint? Has any customer contract added obligations?

### 5.3 Threat enumeration and re-rating (Day 1 afternoon)

Working session, ~3 hours. The bulk of the exercise.

1. **Walk every risk in the register.** For each entry:
   - Confirm the description is still accurate.
   - Re-rate likelihood and impact against the current posture.
   - Confirm the named current controls are in place. If a control has degraded or been removed, the risk's residual rating goes up.
   - Re-evaluate the residual rating.
   - For composite ≥ 16, confirm there is an active mitigation plan and that the plan is making progress.
2. **Add new risks.** Anything surfaced in the postmortems, the threat-modeling notes, or the vendor disclosures that is not in the register.
3. **Close stale risks.** A risk that is no longer applicable (the system it described is gone, the regulatory scope it covered no longer applies) is marked closed with the reason; the entry is not removed from the register.

### 5.4 Control-matrix reconciliation (Day 2 morning)

Working session, ~2 hours.

1. Walk the [control matrix](../security/control-matrix.md). For each row:
   - Confirm the implementation is current.
   - Confirm the evidence location is current.
   - Identify gaps where a control is "Partial" or "Planned" and assess whether the gap should be reflected as a risk in the register.
2. Identify any new controls added in the prior year (e.g. a new ESLint rule, a new test, a new monitoring alert) and add them to the matrix. The matrix is the cross-reference that auditors use; it has to stay current.

### 5.5 SRA refresh (Day 2 afternoon)

Working session, ~2 hours.

1. Refresh the [HIPAA Security Risk Analysis](../security/hipaa-security-risk-analysis.md). The structured sections (Asset inventory, Threat enumeration, Vulnerability enumeration, Safeguard mapping, Risk determination, Residual risk, Action items) are updated against the working notes from §5.2–5.4.
2. The refreshed SRA is the primary deliverable that an external HIPAA-readiness assessor reads first.

### 5.6 Executive review (Day 3)

90-minute session with the CEO. The CTO walks:

- The summary of changes since last year.
- The new risks added.
- The risks whose residual rating moved up (and why).
- The composite ≥ 16 entries and the mitigation plan status.
- The recommended planning items for the next 12 months.

The CEO approves the assessment outputs and signs the refreshed SRA. The signed SRA is filed under `evidence/risk-assessment/<YYYY>/hipaa-sra-v<version>.pdf`.

### 5.7 Distribution and action-item handoff

After CEO approval:

1. The updated risk register, control matrix, and SRA are committed to the repository as the new baseline.
2. Action items are filed in the engineering tracker with owners and due dates. Action-item progress is reported in the next quarterly access review.
3. A one-page executive summary is prepared by the CTO for distribution to interested parties (customers under contract, auditor, prospective customers under NDA).

## 6. Outputs

The annual exercise produces, at minimum:

| Output                                                                              | Location                                                   |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Updated [`risk-register.md`](./risk-register.md)                                    | This repo, committed.                                      |
| Updated [HIPAA Security Risk Analysis](../security/hipaa-security-risk-analysis.md) | This repo, committed.                                      |
| Updated [`../security/control-matrix.md`](../security/control-matrix.md)            | This repo, committed.                                      |
| Executive summary (1 page)                                                          | `evidence/risk-assessment/<YYYY>/executive-summary.pdf`    |
| Working notes (threat models, session transcripts, source inputs)                   | `evidence/risk-assessment/<YYYY>/working/`                 |
| Signed SRA PDF                                                                      | `evidence/risk-assessment/<YYYY>/hipaa-sra-v<version>.pdf` |

A post-incident or material-change assessment produces a subset of the above scoped to the change.

## 7. Quality bar

A risk-assessment output is acceptable when:

- Every risk in the register has a current likelihood, impact, composite, owner, review date, and (for composite ≥ 16) an active mitigation plan with a tracked progress note.
- Every entry in the control matrix is current — implementation accurate, evidence location accurate, owner accurate.
- The SRA's safeguard-mapping section reflects what is actually deployed, not what is planned.
- The action items have named owners and due dates and are linked in the engineering tracker.

The CTO is responsible for the quality bar. The CEO's approval is a sign-off on the outputs, not a substitute for the CTO's review.

## 8. Cross-references

- [`risk-register.md`](./risk-register.md) — the standing register.
- [`../security/hipaa-security-risk-analysis.md`](../security/hipaa-security-risk-analysis.md) — the structured analysis.
- [`../security/control-matrix.md`](../security/control-matrix.md) — the control-to-evidence map.
- [`vendor-inventory.md`](./vendor-inventory.md) — vendor inputs.
- [`baa-tracker.md`](./baa-tracker.md) — PHI-vendor inputs.
- [`access-review-procedure.md`](./access-review-procedure.md) — feeds action-item progress in between annual assessments.
- [Information Security Policy](../policies/information-security-policy.md) — parent.
- [Incident Response Policy](../policies/incident-response-policy.md) — postmortem inputs.
- HIPAA 45 CFR § 164.308(a)(1).
- SOC 2 CC3.

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
