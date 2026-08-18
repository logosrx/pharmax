# Breach Notification Policy

| Field          | Value                |
| -------------- | -------------------- |
| Owner          | CTO                  |
| Approver       | CEO                  |
| Effective date | 2026-08-18           |
| Last reviewed  | 2026-08-18           |
| Next review    | 2027-08-18           |
| Version        | 1.0                  |
| Distribution   | Internal — All staff |

## 1. Purpose and relationship to the incident response policy

[Incident Response Policy](./incident-response-policy.md) governs how an incident
is detected, triaged, contained, and closed. This policy governs a narrower and
more consequential question that begins partway through that process:

> Was this a **breach** of unsecured PHI, and if so, who must be told, by when,
> and what must we be able to prove afterwards?

The two are deliberately separate documents because they answer to different
clocks and different audiences. An incident is closed when the system is safe. A
breach is closed when every notification obligation has been discharged and the
file that proves it has been assembled — which is frequently weeks later, and
which is what a regulator actually inspects.

Nothing here replaces §5 of the incident response policy. That section states
Pharmax's core §164.410 obligation correctly and commits to a 24-hour customer
notification target rather than the 60-day statutory ceiling. This policy adds
the determination procedure, the exceptions, the register, and the proof file.

## 2. Pharmax's role: business associate first

Pharmax processes PHI under BAAs with pharmacy customers. In that posture:

- **Pharmax's obligation is to the covered entity**, under 45 CFR § 164.410.
- **The covered entity notifies individuals**, under § 164.404. Pharmax supplies
  the information they need to do it.
- **The covered entity notifies HHS and media** where § 164.408 and § 164.406
  apply.

Two qualifications matter and are easy to miss.

**Pharmax may itself be a covered entity** for any pharmacy operation it runs
directly rather than on a customer's behalf. Where that is true, the § 164.404,
§ 164.406 and § 164.408 obligations in §6 below are Pharmax's own, not a
customer's. The CTO determines which posture applies at the start of every
breach determination and records the answer in the file; it is not assumed.

**State law frequently does not exempt business associates even where it exempts
covered entities.** A BA-side breach can therefore carry a direct state
obligation that has no federal analogue. See §7.

## 3. What counts as a breach

Under 45 CFR § 164.402, a breach is the acquisition, access, use, or disclosure
of PHI in a manner not permitted by the Privacy Rule which compromises the
security or privacy of that PHI.

**The critical operational fact is the presumption.** An impermissible use or
disclosure of unsecured PHI **is presumed to be a breach** unless Pharmax
demonstrates, through the risk assessment in §5, that there is a **low
probability that the PHI has been compromised.**

The burden runs against us. Silence is not a defence, and neither is an
informal conclusion that "it was probably fine". If the assessment has not been
performed and documented, the incident is a breach.

### 3.1 Unsecured PHI and the encryption safe harbour

The rule applies only to **unsecured** PHI — PHI not rendered unusable,
unreadable, or indecipherable through a method meeting the HHS specification.

Pharmax's encryption posture is documented in
[`../security/encryption-overview.md`](../security/encryption-overview.md).
Disclosure of ciphertext without the corresponding keys is not a disclosure of
unsecured PHI and does not trigger this policy. The CTO consults legal counsel
before classifying any disclosure as out of scope on this basis, and records the
reasoning in the file — the safe harbour is a conclusion to be evidenced, not
an assumption to be made.

Note what the safe harbour does **not** cover: data decrypted into application
memory, rendered into a page, written to a log, echoed by a vendor API, or
recovered by a party who also holds the key.

### 3.2 The three statutory exceptions

45 CFR § 164.402(1) excludes three categories from the definition of breach.
Each requires the good-faith and scope conditions to hold; none is a general
excuse.

1. **Unintentional acquisition, access, or use by a workforce member** acting
   under Pharmax's authority, in good faith and within the scope of that
   authority, provided the PHI is not further used or disclosed impermissibly.
   _Example: an operator opens the wrong patient record, recognises the error,
   and closes it._
2. **Inadvertent disclosure between two persons authorised to access PHI** at
   Pharmax or the covered entity, provided the PHI is not further used or
   disclosed impermissibly. _Example: PHI routed to the wrong authorised
   pharmacist within the same organisation._
3. **A disclosure where Pharmax has a good-faith belief that the unauthorised
   recipient would not reasonably have been able to retain the information.**
   _Example: a page rendered momentarily to a session that closed before the
   content could be read or captured._

Applying an exception is a documented determination, subject to the same
recording and retention requirements as a risk assessment. The exception
relied on, the facts supporting each condition, and the approver are recorded
in the file.

## 4. Discovery and when the clock starts

A breach is **discovered** on the first day it is known, or by exercising
reasonable diligence would have been known, to any workforce member or agent
other than the person who committed it.

This is earlier than most teams assume. The clock does not start when the
severity is confirmed, when legal counsel is engaged, or when the investigation
concludes. Two consequences follow:

- **Discovery is recorded explicitly**, with a timestamp and the name of the
  person who first knew, at the moment the possibility of PHI exposure is
  raised — not retrospectively once it is confirmed.
- **Reasonable diligence is a standard we are held to.** An exposure that our
  own monitoring should have surfaced may be deemed discovered when it became
  detectable, not when someone happened to look. This is one of the reasons the
  §164.308(a)(1)(ii)(D) activity review in
  [`../governance/access-review-procedure.md`](../governance/access-review-procedure.md)
  is a compliance control and not merely an operational nicety.

## 5. The four-factor risk assessment

To overcome the presumption in §3, Pharmax must demonstrate a low probability
of compromise through a risk assessment addressing **all four** factors in
45 CFR § 164.402(2). All four are assessed; a favourable answer on three does
not carry the fourth.

| #   | Factor                                                                                           | What we evaluate                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Nature and extent of the PHI**, including identifier types and likelihood of re-identification | Which fields, how many individuals, whether clinical detail was present, whether direct identifiers were involved                                   |
| 2   | **The unauthorised person** who used the PHI or to whom it was disclosed                         | Whether the recipient is another HIPAA-regulated entity or BAA-covered vendor, an internal actor without need-to-know, or an unknown external party |
| 3   | **Whether the PHI was actually acquired or viewed**                                              | Access logs, audit-chain entries, delivery ledgers, carrier or vendor confirmations — evidence of retrieval, not merely of exposure                 |
| 4   | **The extent to which the risk has been mitigated**                                              | Recipient attestations of destruction, revoked credentials, key rotation, crypto-shred, confirmed non-retention                                     |

The assessment is performed using
[`../compliance/breach-risk-assessment-template.md`](../compliance/breach-risk-assessment-template.md),
which is the required form. It is completed by the CTO, reviewed by the Security
Officer, and approved by the CEO. Where the conclusion is "not a breach", legal
counsel reviews before the determination is final.

**Pharmax's evidence position on factor 3 is unusually strong and should be
used.** The hash-chained audit log, the `ViewPatient` read-access records, and
the delivery ledgers make "was it actually retrieved?" an answerable question
rather than a speculative one. Where that evidence exists it is cited directly
in the assessment; where it does not, the assessment says so plainly rather than
inferring absence of access from absence of records.

## 6. Notification obligations

### 6.1 Business associate to covered entity — § 164.410

Governed by [Incident Response Policy](./incident-response-policy.md) §5.1.
Statutory ceiling is 60 calendar days from discovery; Pharmax's operating target
is **24 hours from confirmation**, because the covered entity cannot meet its own
downstream deadlines if we consume the window.

### 6.2 Individual notice — § 164.404

Applies where Pharmax is the covered entity. Where Pharmax is the business
associate, Pharmax supplies the content elements below so the customer can meet
this obligation.

- **Deadline:** without unreasonable delay, no later than **60 calendar days**
  from discovery — **or sooner where state law requires it.** See §7. Treat 60
  days as a ceiling that state law lowers, never as a target.
- **Required content**, all five elements:
  1. A brief description of what happened, including the date of the breach and
     the date of discovery, if known.
  2. A description of the **types** of unsecured PHI involved — not the PHI
     itself.
  3. Steps individuals should take to protect themselves from potential harm.
  4. What Pharmax (or the covered entity) is doing to investigate, mitigate
     harm, and protect against further breaches.
  5. Contact procedures for questions — a toll-free number, email address,
     website, or postal address.
- **Method:** written notice by first-class mail to the last known address, or
  by email where the individual has agreed to electronic notice.
- **Urgent cases:** where there is possible imminent misuse, notice by telephone
  or other means **in addition to** written notice.
- **Substitute notice:** where contact information is insufficient or out of
  date, for **10 or more** individuals, by either a conspicuous posting for 90
  days on the home page of the website or notice in major print or broadcast
  media, together with a toll-free number active for at least 90 days.

### 6.3 Media notice — § 164.406

Required for a breach affecting **more than 500 residents of a single state or
jurisdiction** — not 500 individuals in aggregate. A 900-person breach spread
across twelve states may trigger no media notice at all; a 501-person breach
confined to one state does.

Notice is to prominent media outlets serving that state or jurisdiction, without
unreasonable delay and no later than 60 calendar days from discovery, carrying
the same content elements as §6.2.

### 6.4 HHS notification — § 164.408

| Breach size                    | Deadline                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **500 or more individuals**    | Contemporaneously with individual notice, and no later than 60 calendar days from discovery                              |
| **Fewer than 500 individuals** | Logged as they occur, submitted to HHS **within 60 days after the end of the calendar year** in which discovery occurred |

The sub-500 obligation is the one most often missed, because it has no incident
to prompt it — it is an annual filing that depends on a register having been
maintained all year. That register is defined in §8.

## 7. State law

State breach notification statutes apply **in addition to** HIPAA. HIPAA sets a
federal floor and does not preempt stricter state requirements.

Three facts drive our operating posture:

1. **State deadlines can be shorter than 60 days.** California's fixed 30-day
   individual-notice deadline took effect 1 January 2026, with Attorney General
   notice within 15 days of individual notice for breaches affecting more than
   500 California residents. Running to HIPAA's 60-day ceiling would breach
   California law by a month.
2. **A HIPAA exemption is usually conditional, not absolute.** Several states
   deem HIPAA-compliant entities compliant with state law _provided_ they also
   notify the state Attorney General, sometimes within a tighter window than the
   individual notice itself.
3. **Business associates are frequently not exempt even where covered entities
   are.** This is the exposure most specific to Pharmax's posture, and it means
   a BA-side breach can carry a direct state obligation with no federal analogue.

The per-state analysis lives in
[`../compliance/state-breach-notification-matrix.md`](../compliance/state-breach-notification-matrix.md).
It is a research aid maintained against public sources, **not legal advice**;
counsel confirms the applicable obligations for any actual breach before notice
is issued. The matrix exists so that the confirmation conversation starts from a
prepared position under time pressure, not from a blank page.

Determining which states are implicated requires the **residence** of each
affected individual, not the location of the pharmacy or the clinic. That
mapping is produced during the assessment.

## 8. The breach register

Pharmax maintains a register of every breach determination, including those
concluding "not a breach".

The register is the system of record for:

- the § 164.408 sub-500 annual submission to HHS;
- the § 164.414 burden of proof;
- the annual pattern review required by §7 of the incident response policy.

Each entry records the incident reference, discovery date and discoverer,
Pharmax's role (BA or CE), affected individual count and state distribution,
PHI categories involved, the risk-assessment conclusion with its four-factor
basis or the exception relied upon, every notification made with its date and
recipient, and the location of the evidence file.

Determinations of "not a breach" are registered with equal rigour. Under
§ 164.414 the burden is on Pharmax to demonstrate that notification was not
required — an unrecorded determination is indistinguishable from an unmade one.

## 9. Burden of proof and retention — § 164.414

For every breach determination Pharmax assembles a single evidence file at
`evidence/breaches/<YYYY>/<incident-id>/` containing the completed risk
assessment with signatures, the determination and its reasoning, copies of every
notice issued with proof of sending, HHS and media submissions where applicable,
state notifications, recipient attestations relied on for mitigation, and the
supporting audit-chain extracts.

Retention is **six years** from the date of the determination or the last
notification, whichever is later, per 45 CFR § 164.530(j).

The standard this file must meet is not "we responded well". It is that a
regulator arriving three years later can reconstruct what was decided, on what
evidence, by whom, and on what date — from the file alone, without interviewing
anyone who was there.

## 10. Roles

| Role                   | Responsibility                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **CTO**                | Determines BA/CE posture; performs the risk assessment; owns the register and the evidence file                                    |
| **Security Officer**   | Reviews every risk assessment; validates the factor-3 evidence position                                                            |
| **CEO**                | Approves every determination; approves external notice content                                                                     |
| **Legal counsel**      | Reviews every "not a breach" conclusion and every encryption-safe-harbour classification; confirms state obligations before notice |
| **Compliance Officer** | Maintains the state matrix; prepares the annual HHS submission                                                                     |

## 11. Testing

The breach determination path is exercised in the annual incident-response
tabletop required by
[`../soc2/playbooks/incident-response.md`](../soc2/playbooks/incident-response.md).
At least one scenario per exercise runs to a completed four-factor assessment
and a register entry, because a procedure that has never been executed under
time pressure is a document rather than a control.

## Revision history

| Version | Date       | Author | Change                                                                                                                                                                                                                                         |
| ------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-08-18 | CEO    | Added to the adopted policy bundle. Separates breach determination and notification from incident mechanics; adds the § 164.402 presumption, the four-factor assessment, the statutory exceptions, the register, and the § 164.414 proof file. |
