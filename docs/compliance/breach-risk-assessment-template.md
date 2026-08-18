# Breach Risk Assessment — 45 CFR § 164.402(2)

> **Copy this file to `evidence/breaches/<YYYY>/<incident-id>/risk-assessment.md`
> and complete it there. Do not edit this template in place.**

Governed by [Breach Notification Policy](../policies/breach-notification-policy.md).

---

## Before you start: what this form is for

An impermissible use or disclosure of unsecured PHI **is presumed to be a
breach.** This form is the only way to rebut that presumption. It succeeds only
by demonstrating a **low probability that the PHI has been compromised**, across
**all four** statutory factors.

Three things follow, and they are the reason this form is prescriptive:

- **A favourable answer on three factors does not carry the fourth.** Each is
  assessed and recorded on its own evidence.
- **"We have no indication it was accessed" is not a finding.** Absence of
  evidence is only meaningful where evidence would exist if the event had
  occurred. State which log would have recorded it, and whether that log was
  operating.
- **An incomplete form is a breach determination.** If this assessment is not
  finished and approved, the presumption stands and notification obligations run.

---

## Section A — Incident identification

| Field                                                        | Value |
| ------------------------------------------------------------ | ----- |
| Incident ID                                                  |       |
| Assessment date                                              |       |
| **Date of breach** (or range, if known)                      |       |
| **Date of discovery**                                        |       |
| **Discovered by** (name, role)                               |       |
| How discovery occurred (alert, report, review, customer)     |       |
| Pharmax's role: **Business Associate** or **Covered Entity** |       |
| Affected covered entities / customers                        |       |

**Discovery date is the first day the incident was known, or by reasonable
diligence would have been known, to any workforce member other than the person
who caused it.** Not the day severity was confirmed. Every downstream deadline
runs from this date, so if it is uncertain, record the earliest defensible date
and say why.

---

## Section B — Threshold questions

Answer these first. Either can end the assessment.

### B1. Was the PHI _unsecured_?

| Question                                                                                                                                         | Answer |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Was the PHI encrypted to the HHS specification at the moment of exposure?                                                                        |        |
| Did the unauthorised party have, or plausibly obtain, the decryption keys?                                                                       |        |
| Was the data decrypted anywhere in the exposure path — application memory, a rendered page, a log line, a vendor API response, an error message? |        |

If the PHI was encrypted at rest **and** the keys were not exposed **and** it was
not decrypted anywhere in the path, the safe harbour applies and this is not a
breach. **Legal counsel must review before relying on this conclusion.**

Counsel reviewer and date: ______________________

> The most common error here is stopping at "the database is encrypted."
> Pharmax decrypts PHI into process memory for rendering, for label generation,
> and for carrier transmission. Trace the actual path of the exposed data.

### B2. Does a § 164.402(1) exception apply?

| Exception                                                                                                                                             | Applies? | Facts supporting **every** condition |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------ |
| **(i)** Unintentional acquisition/access/use by a workforce member acting in good faith within scope, with no further impermissible use or disclosure |          |                                      |
| **(ii)** Inadvertent disclosure between two persons authorised to access PHI, with no further impermissible use or disclosure                         |          |                                      |
| **(iii)** Good-faith belief the unauthorised recipient could not reasonably have retained the information                                             |          |                                      |

An exception applies only if **all** of its conditions hold. Record the facts,
not the conclusion.

Approver and date: ______________________

---

## Section C — The four factors

Complete all four. Each carries its own evidence.

### Factor 1 — Nature and extent of the PHI

| Field                                                                                                       | Value |
| ----------------------------------------------------------------------------------------------------------- | ----- |
| PHI field categories involved (names, addresses, DOB, SSN, MRN, diagnoses, medications, allergies, payment) |       |
| Were **direct identifiers** present?                                                                        |       |
| Was **clinical** information present (medication, allergy, screening finding, diagnosis)?                   |       |
| Number of individuals affected                                                                              |       |
| **State-by-state distribution by individual residence** (drives §164.406 and state law)                     |       |
| Re-identification risk if identifiers were partial or coded                                                 |       |

> Persistent record identifiers count. A `patientId` that resolves to a person
> for anyone holding the mapping is an identifier under § 164.514(b)(2)(i)(R),
> not a de-identifier. Do not record a payload as low-risk merely because names
> were absent.

**Factor 1 assessment:**

### Factor 2 — The unauthorised person

| Field                                                                                   | Value |
| --------------------------------------------------------------------------------------- | ----- |
| Who received or accessed the PHI?                                                       |       |
| Are they a HIPAA-regulated entity, or a vendor under an executed BAA?                   |       |
| If internal: did they have PHI access generally, but no need-to-know for these records? |       |
| If external: identified, or unknown?                                                    |       |
| Do they have an independent legal obligation to protect the PHI?                        |       |

> A disclosure to a BAA-covered vendor is materially lower risk than one to an
> unknown external party — but only where the BAA is **executed**. Check
> [`../governance/baa-tracker.md`](../governance/baa-tracker.md) and record the
> status; do not assume.

**Factor 2 assessment:**

### Factor 3 — Whether the PHI was actually acquired or viewed

This is the factor Pharmax is best positioned to answer with evidence rather
than inference. Use that.

| Evidence source                                                | Available? | What it shows |
| -------------------------------------------------------------- | ---------- | ------------- |
| `audit_log` hash-chained entries for the affected records      |            |               |
| `patient.viewed` read-access records (`ViewPatient`)           |            |               |
| `command_log` entries                                          |            |               |
| Delivery ledgers (`webhook_delivery`, `notification_delivery`) |            |               |
| Carrier / vendor API confirmations                             |            |               |
| Web server or CDN access logs                                  |            |               |
| Recipient's own attestation                                    |            |               |

| Question                                                                                                  | Answer |
| --------------------------------------------------------------------------------------------------------- | ------ |
| Is there **positive evidence** the PHI was retrieved, opened, or transmitted?                             |        |
| If there is no such evidence — **would there be, had it occurred?** Which control would have recorded it? |        |
| Was that control **operating** during the exposure window?                                                |        |

> The second and third questions are what separate a finding from a hope. If
> the recording control was not operating, say so — that weakens factor 3 and it
> is better recorded honestly than discovered by a regulator.

**Factor 3 assessment:**

### Factor 4 — Extent to which the risk has been mitigated

| Field                                                                        | Value |
| ---------------------------------------------------------------------------- | ----- |
| Mitigating actions taken, with timestamps                                    |       |
| Written assurance of destruction or non-retention obtained? From whom, when? |       |
| Credentials revoked / keys rotated / crypto-shred performed?                 |       |
| Was mitigation completed **before** the PHI could be used?                   |       |
| Residual exposure that could not be mitigated                                |       |

> Verbal assurances carry little weight. A signed attestation from an identified
> recipient carries real weight. Record which you have.

**Factor 4 assessment:**

---

## Section D — Other factors

§ 164.402(2) requires the four factors as a **minimum**. Record anything else
bearing on the probability of compromise — the exposure duration, whether the
data was indexed or cached, whether it reached a public network, the
sophistication of the recipient.

---

## Section E — Determination

| Field                                                                       | Value                                                                                                                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conclusion**                                                              | ☐ Breach — notification required · ☐ Not a breach — low probability of compromise demonstrated · ☐ Not a breach — exception applies · ☐ Not a breach — secured PHI (safe harbour) |
| Reasoning, referencing each factor                                          |                                                                                                                                                                                   |
| Notifications triggered (§164.410 / §164.404 / §164.406 / §164.408 / state) |                                                                                                                                                                                   |
| Earliest applicable deadline **and its source**                             |                                                                                                                                                                                   |

> The earliest deadline is frequently **not** HIPAA's 60 days. Check
> [`state-breach-notification-matrix.md`](./state-breach-notification-matrix.md)
> against the residence distribution from Factor 1 before writing a date here.
> California's individual-notice deadline is 30 days; several states require
> Attorney General notice sooner than that.

### Signatures

| Role                                            | Name | Date | Signature |
| ----------------------------------------------- | ---- | ---- | --------- |
| Prepared by — CTO                               |      |      |           |
| Reviewed by — Security Officer                  |      |      |           |
| Legal counsel (required for any "not a breach") |      |      |           |
| Approved by — CEO                               |      |      |           |

---

## Section F — Register and file

| Step                                                                 | Done | Date |
| -------------------------------------------------------------------- | ---- | ---- |
| Entry created in the breach register                                 |      |      |
| Evidence file assembled at `evidence/breaches/<YYYY>/<incident-id>/` |      |      |
| Audit-chain extracts attached                                        |      |      |
| Copies of every notice attached, with proof of sending               |      |      |
| Added to the § 164.408 sub-500 annual log (if applicable)            |      |      |

Retention: **six years** from determination or last notification, whichever is
later — 45 CFR § 164.530(j).

**A "not a breach" determination is registered and filed with the same rigour as
a breach.** Under § 164.414 the burden is on Pharmax to demonstrate notification
was not required, and an unrecorded determination is indistinguishable from one
that was never made.
