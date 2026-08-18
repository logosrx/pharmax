# State Breach Notification Matrix

| Field          | Value                           |
| -------------- | ------------------------------- |
| Owner          | Compliance Officer              |
| Approver       | CTO                             |
| Effective date | 2026-08-18                      |
| Last reviewed  | 2026-08-18                      |
| Next review    | 2026-11-18 (quarterly — see §5) |
| Version        | 1.0                             |
| Distribution   | Internal — All staff            |

> **This is a research aid, not legal advice.** No notice is issued on the basis
> of this document alone. Legal counsel confirms the applicable obligations for
> any actual breach before notification. The matrix exists so that conversation
> starts from a prepared position at 2am, not from a blank page.

Governed by [Breach Notification Policy](../policies/breach-notification-policy.md) §7.

## 1. Why this document exists

HIPAA's 60-day individual-notice deadline is a **ceiling, not a target.** State
law sets the floor, and in a growing number of states the floor is higher than
the ceiling.

Three facts drive everything below:

**State deadlines can be shorter than HIPAA's.** California's fixed 30-day
individual-notice deadline took effect 1 January 2026 under SB 446, with
Attorney General notice within 15 days of individual notice above 500 California
residents. An organisation that runs to day 55 because "HIPAA allows 60" has
violated California law by nearly a month.

**A HIPAA exemption is usually conditional.** Many states deem HIPAA-compliant
entities compliant with state law — but frequently only if the state Attorney
General is also notified, sometimes on a tighter clock than the individual
notice.

**Business associates are often not exempt where covered entities are.** This is
the exposure most specific to Pharmax. A BA-side breach can carry a direct state
obligation with no federal analogue, and the exemption a customer relies on may
not extend to us.

## 2. How to use this in an incident

Do this in order. It takes about twenty minutes and it determines every
subsequent deadline.

1. **Produce the residence distribution.** From Factor 1 of the
   [risk assessment](./breach-risk-assessment-template.md), count affected
   individuals **by state of residence** — not by pharmacy location, not by
   clinic location. Residence is what triggers state law.
2. **Identify every implicated state.** Any state with one or more affected
   residents is implicated. There is no de minimis threshold for the obligation
   to exist; thresholds affect _who else_ must be told, not _whether_ notice is
   required.
3. **Confirm Pharmax's posture per state** — business associate or covered
   entity. The answer can differ from the federal analysis (§7 of the policy).
4. **Take the earliest deadline across all implicated states**, and treat that
   as the binding date for the whole notification programme. Running separate
   clocks per state is how one gets missed.
5. **Check the §164.406 media threshold separately.** It counts residents of a
   single state, so it can trigger on a small breach concentrated in one state
   and not trigger on a large one spread thin.
6. **Send the state list to counsel for confirmation** before any notice issues.

### Worked example

A breach affects 900 individuals: 520 in California, 300 in Texas, 80 across
six other states.

- **§164.406 media notice: triggered** — more than 500 residents of a single
  state (California). A 900-person breach spread evenly across twelve states
  would not trigger it.
- **§164.408 HHS: immediate** — 500+ in aggregate, contemporaneous with
  individual notice.
- **Binding individual-notice deadline: 30 days**, set by California, not the
  federal 60. Every other state's notice goes out on that clock too.
- **California AG notice** within 15 days of individual notice, being above 500
  California residents.

## 3. Verification status

Populating all 51 jurisdictions with verified statutory detail is a legal
research task, not an engineering one. This version therefore records:

- the **columns that drive operational behaviour**, so the framework is complete;
- entries **verified against a cited source on a stated date**;
- entries **explicitly marked unverified**, rather than filled with plausible
  guesses.

An unverified cell is safer than a wrong one. A wrong deadline in this table
produces a missed statutory notification, which is the exact harm the table
exists to prevent.

**Working source for population:** Foley & Lardner LLP, _State Data Breach
Notification Laws_, current as of 4 March 2026. Used as a research starting
point; each row must be confirmed against the primary statute and counsel before
it moves to `Verified`.

## 4. The matrix

Columns, and why each is here:

| Column                      | Drives                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| **HIPAA exemption**         | Whether state notice is owed at all — `Full`, `Conditional` (usually AG notice still required), or `None` |
| **BA exempt?**              | Whether Pharmax's own BA-side obligation exists independent of the customer's                             |
| **Individual deadline**     | The binding clock where tighter than HIPAA's 60 days                                                      |
| **AG notice**               | Threshold and deadline for Attorney General notification                                                  |
| **Encryption safe harbour** | Whether ciphertext exposure is out of scope under state law as well as federal                            |

### Verified entries

| State            | Statute                                                                 | HIPAA exemption                                     | BA exempt?                                           | Individual deadline                                                  | AG notice                                                                 | Verified   |
| ---------------- | ----------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------- |
| **California**   | Cal. Civ. Code § 1798.80 et seq.; § 1798.82 as amended by SB 446 (2025) | Conditional                                         | Confirm with counsel                                 | **30 calendar days** — strictest fixed timeline in the US as of 2026 | Within **15 calendar days** of individual notice, where >500 CA residents | 2026-08-18 |
| **Pennsylvania** | 73 Pa. Stat. § 2301 et seq. (BPINA), as amended by Act 33 of 2024       | Full — HIPAA-compliant CEs and BAs deemed compliant | Yes — BAs expressly covered by the deeming provision | Without unreasonable delay; no fixed day count                       | **Concurrent** with consumer notice, where >500 PA residents              | 2026-08-18 |

California is the binding constraint for any breach touching a California
resident and should be treated as the planning assumption until the residence
distribution proves otherwise.

### Awaiting verification

The following jurisdictions require population before this matrix can be relied
on for a multi-state breach. Each needs the six columns above confirmed against
the primary statute, with counsel sign-off.

Alabama · Alaska · Arizona · Arkansas · Colorado · Connecticut · Delaware ·
District of Columbia · Florida · Georgia · Hawaii · Idaho · Illinois · Indiana ·
Iowa · Kansas · Kentucky · Louisiana · Maine · Maryland · Massachusetts ·
Michigan · Minnesota · Mississippi · Missouri · Montana · Nebraska · Nevada ·
New Hampshire · New Jersey · New Mexico · New York · North Carolina ·
North Dakota · Ohio · Oklahoma · Oregon · Rhode Island · South Carolina ·
South Dakota · Tennessee · Texas · Utah · Vermont · Virginia · Washington ·
West Virginia · Wisconsin · Wyoming

**Known partial signals**, recorded so they are not lost — each still requires
confirmation before use:

- **Florida** — reportedly permits forwarding the HHS notice to the Attorney
  General rather than a separate notice letter.
- **Hawaii, Indiana** — reportedly exempt HITECH-compliant entities from state
  AG notification.

### Priority order for population

Populate in this order rather than alphabetically — it front-loads the states
most likely to bind:

1. **States with fixed deadlines shorter than 60 days.** These change the
   binding date and are the only ones that can make an otherwise-compliant
   response late.
2. **States where the dispensing footprint is largest**, by resident volume.
3. **States with no HIPAA exemption**, where obligations are fully independent.
4. Everything else.

## 5. Maintenance

State breach statutes change frequently — California, Pennsylvania and Texas all
amended within the last two years. A stale matrix is worse than none, because it
invites reliance.

- **Quarterly review** by the Compliance Officer against the current source
  chart, with the review date recorded in the front matter.
- **On-event review** whenever the dispensing footprint enters a new state.
- **Entries carry their own verification date.** An entry not verified within
  twelve months reverts to `Awaiting verification` and is treated as unknown.
- The quarterly review is evidenced under
  `evidence/policies/<year>/state-matrix-review.md`.

## Revision history

| Version | Date       | Author | Change                                                                                                                                                                                                                              |
| ------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-08-18 | CEO    | Initial framework. Operational deadline logic, worked example, and column structure established; California and Pennsylvania verified; remaining 49 jurisdictions marked awaiting verification rather than populated speculatively. |
