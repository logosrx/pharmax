# Compliance Calendar

| Field          | Value                |
| -------------- | -------------------- |
| Owner          | CTO                  |
| Effective date | 2026-08-20           |
| Last reviewed  | 2026-08-20           |
| Next review    | 2027-08-20           |
| Version        | 1.0                  |
| Distribution   | Internal — All staff |

## 1. What this is for

Every other document in the bundle states a **cadence**. None of them
states a **date**. That difference is the whole reason this file exists:
"quarterly" is a policy, "2026-11-30" is something you can miss, notice
you missed, and be asked about.

It matters more than usual right now. A SOC 2 Type II observation window
does not test whether controls are well designed — it samples whether
they **recurred**. As of 2026-08-20, three obligations have completed one
cycle and **none has completed two**. Until that changes there is nothing
for a window to sample, and the window is the only part of the path that
gets longer the later it starts.

## 2. How to read the status column

- **Running** — automated, currently executing, evidence accruing.
- **Cycle 1 done** — has operated exactly once. Not yet a pattern.
- **Never run** — designed and adopted, no execution.
- **Blocked** — cannot run until a named prerequisite clears.

A control that is `Never run` is not a failure of diligence; the bundle
was adopted on 2026-08-18. It becomes a failure the moment its first due
date passes without it.

## 3. Automated — running today

These need no calendar entry to happen. They are listed so that their
**absence** is noticeable, which is the failure mode R-028 records: a
control that runs, succeeds, and delivers nowhere.

| What                        | When                                 | Evidence it produces                              | Status                    |
| --------------------------- | ------------------------------------ | ------------------------------------------------- | ------------------------- |
| Audit-chain verifier        | Daily 01:30 UTC                      | CloudWatch metric feeding the SEV1 alarm          | Running                   |
| Merkle root signing         | Daily 02:00 UTC                      | Signed manifest in the Object-Lock bucket         | Running                   |
| Nightly security digest     | Daily 02:30 UTC                      | Digest — **currently logged only, no recipient**  | Running, degraded (R-028) |
| Compliance probes           | Every 5 min, per-check cadence       | `compliance_check_run` rows                       | Running, 7 of 69 controls |
| Access-review evidence pack | First day of each quarter, 03:00 UTC | Evidence pack — **notification has no recipient** | Running, degraded (R-028) |

Ordering is deliberate: verify at 01:30 runs **before** signing at 02:00,
so tampering is caught before the day's manifest seals it.

## 4. Quarterly — the single quarterly event

The access review is the only quarterly compliance event by design. Five
things that read like separate quarterly commitments elsewhere are line
items inside it, and four more were folded in on 2026-08-20.

| Cycle   | Window opens | Reports generated | Review complete | Sign-off filed | Status           |
| ------- | ------------ | ----------------- | --------------- | -------------- | ---------------- |
| 2026-Q3 | 2026-07-01   | —                 | 2026-08-19      | 2026-08-19     | **Cycle 1 done** |
| 2026-Q4 | 2026-10-01   | by 2026-10-31     | by 2026-11-15   | by 2026-11-30  | Scheduled        |
| 2027-Q1 | 2027-01-01   | by 2027-01-31     | by 2027-02-15   | by 2027-02-28  | Scheduled        |

**2026-Q4 is the important one.** It is the first _recurrence_ of anything
in this bundle, and a Type II window cannot sample a pattern of one.

The Q3 cycle covered the infrastructure half only; the application-RBAC
half was recorded as a reasoned non-applicability because zero
organizations existed. If a tenant onboards before Q4, both halves run.

## 5. Annual

| What                                                         | Due                                       | Last done             | Status                              |
| ------------------------------------------------------------ | ----------------------------------------- | --------------------- | ----------------------------------- |
| Security awareness + HIPAA training                          | 2026-12-31                                | Never                 | **Never run**                       |
| Policy bundle review (20 documents)                          | 2027-08-18                                | 2026-08-18 (adoption) | Scheduled                           |
| Risk assessment + SRA refresh                                | Q2 2027 by policy; **first one owed now** | Never                 | **Never run**                       |
| Incident-response tabletop                                   | Annual                                    | 2026-08-19            | Cycle 1 done                        |
| DR restore drill (one full restore)                          | Annual                                    | 2026-07-23            | Cycle 1 done, **against zero rows** |
| DR scenario tabletop (rotating)                              | Annual                                    | Never                 | **Never run**                       |
| Vendor review, staggered per vendor                          | 12 months from each vendor's last review  | 2026-08-18            | Scheduled                           |
| BAA review, all rows                                         | 2027-08-18                                | 2026-08-18            | Scheduled                           |
| Sentry "aggregated identifying data" toggle re-confirmed off | Annual                                    | 2026-08-18            | Scheduled                           |
| AWS HIPAA-eligible service list re-confirmed                 | Annual                                    | 2026-08-20            | Scheduled                           |
| Clean-room contributor attestation                           | Annual                                    | Never                 | **Never run**                       |
| Static-analysis dismissal review                             | Annual                                    | Never                 | **Never run**                       |
| Training effectiveness review                                | Annual                                    | Never                 | Blocked on training                 |
| Sub-500 breach filing to HHS                                 | Within 60 days of calendar year end       | N/A — no breaches     | Scheduled                           |

### The two that are overdue in substance

**Training** is a _required_ implementation specification under
§ 164.308(a)(5), not an addressable one, and it is at absolute zero. Its
stated due date is 2026-12-31, so it is not yet late — but it is the item
an assessor finds first, and the platform naming its provider in
placeholder brackets means procurement has not started either.

**The risk assessment** is scheduled for Q2 by policy but is owed now,
because the register needs a baseline before it can be refreshed. This is
first-cycle Session 7.

## 6. Event-triggered

No date, but the clock starts the moment the event occurs — and these are
the ones that get missed, because nothing reminds you.

| Trigger                    | Deadline                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Involuntary departure      | Deprovision **same business day**                                                                              |
| Voluntary departure        | Deprovision by last day of work                                                                                |
| New person, any status     | AUP acknowledged Day 1; core modules by end of Week 1; role modules by end of Month 1                          |
| Material policy change     | Re-acknowledgment within 30 days                                                                               |
| Role change                | New role's modules within 30 days                                                                              |
| SEV0/1/2 incident          | Postmortem published within 48 hours of mitigation                                                             |
| Emergency change           | Retroactive PR review within 24 hours                                                                          |
| Vendor CVE or disclosure   | Exposure assessed within one business day                                                                      |
| Breach confirmed           | BA-to-CE notice: 24 hours internal target, 60 days statutory                                                   |
| Breach, individuals        | 60 days federal ceiling; **California 30 days**, AG within 15 days of individual notice above 500 CA residents |
| Break-glass session opened | Closed within 60 minutes default, 240 hard ceiling                                                             |
| Policy exception granted   | Expires in 90 days; 30 days non-renewable for clean-room                                                       |

The state deadlines are the sharpest edge. They are statutory, they do not
pause for staffing, and per [BCDR §3.4](../policies/business-continuity-and-disaster-recovery.md)
the sole-operator acceptance explicitly does not extend to them.

## 7. What has to happen before a Type II window is worth starting

Ordered. Each is a prerequisite for the next being meaningful.

1. **R-028 closed in production.** Controls that notify nobody are
   sampled as controls that did not operate. The infrastructure is
   provisioned; two operator steps remain.
2. **Training completed once.** The only required specification at zero.
3. **Risk assessment run once** (Session 7), giving the register a
   baseline.
4. **2026-Q4 access review completed.** The first recurrence, and the
   moment "we have controls" becomes "our controls recur."

Steps 1 to 3 are weeks of work. Step 4 is a date on this page and cannot
be pulled forward — which is precisely why steps 1 to 3 should not slip
past it.

## 8. Maintaining this file

This calendar is **hand-maintained and will rot**, in exactly the way the
control matrix did before 2026-08-20. Dates copied out of policy documents
stop agreeing with them the first time a cadence changes, and nothing here
would notice.

Two mitigations, neither yet built:

- Policy `Next review` dates already live in a header table in twenty
  documents. A gate could parse them and fail when this calendar
  disagrees, in the pattern of
  [`check-kms-inventory.ts`](../../scripts/check-kms-inventory.ts) and
  [`check-compliance-controls.ts`](../../scripts/check-compliance-controls.ts).
- The compliance probe framework already has
  `identity.access_review.period_freshness`, which fails when the newest
  access-review snapshot exceeds 100 days. That is the pattern to repeat
  for every dated obligation here: a machine watchdog on a human deadline
  is worth more than a calendar entry, because it complains.

Until then, this file is reviewed at each quarterly access review.

## 9. Cross-references

- [Access review procedure](../governance/access-review-procedure.md) — the quarterly event
- [First-cycle runbook](./first-cycle-runbook.md) — getting each control to its first run
- [Security training program](../governance/security-training-program.md)
- [Risk assessment procedure](../governance/risk-assessment-procedure.md)
- [BCDR policy](../policies/business-continuity-and-disaster-recovery.md) §8, drill cadence
- [Breach notification policy](../policies/breach-notification-policy.md) §6, §7
- [Evidence digest ledger](./evidence-digest-ledger.md) — where signed artifacts are fixed

## Revision history

| Version | Date       | Author | Change                                                                                                                                                                                                                            |
| ------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-08-20 | CTO    | Created. Every policy in the bundle states a cadence and none states a date, which is survivable until an observation window needs to sample recurrence. Records the four-step prerequisite for that window being worth starting. |
