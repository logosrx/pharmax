# Customer BAA Template — Pharmax as Business Associate

| Field          | Value                       |
| -------------- | --------------------------- |
| Owner          | [Owner: CTO]                |
| Approver       | [Approver: CEO]             |
| Effective date | [Effective date: TBD]       |
| Last reviewed  | [Last reviewed: YYYY-MM-DD] |
| Next review    | [Next review: YYYY-MM-DD]   |
| Version        | 0.1 — draft, not for use    |
| Distribution   | Internal — All staff        |

> **Why this is still `TBD` when the rest of the bundle is 1.0.** The
> 2026-08-18 adoption gave every governance document a real effective date.
> This one and its [register](./customer-baa-register.md) were deliberately
> left out: adopting a contract template that counsel has not reviewed
> would assert a legal instrument with no legal review behind it, which is
> the same failure as adopting a policy stub. It gets a date when counsel
> returns it, not when the batch was signed.

> **THIS DRAFT HAS NOT BEEN REVIEWED BY COUNSEL AND MUST NOT BE SENT TO A
> CUSTOMER.** It exists so that licensed counsel reviews and revises a
> complete, citation-mapped draft rather than drafting from a blank page.
> Every clause below is annotated with the HIPAA provision it satisfies so
> counsel can verify coverage quickly. Statements about what Pharmax
> technically does are load-bearing contractual representations: §7 lists
> the ones that are **not true yet**, and the agreement must not be signed
> while any of them remains false.

## 0. Why this document exists

The [BAA tracker](./baa-tracker.md) records BAAs that flow **upstream** —
Pharmax obtaining assurances from AWS, EasyPost, Sentry and others. It does
not cover the **downstream** direction, and that direction is the one that
gates revenue.

Pharmax is a Business Associate of its pharmacy customers
([HIPAA SRA §1](../security/hipaa-security-risk-analysis.md),
[Vendor Management Policy §1](../policies/vendor-management-policy.md)). The
customer pharmacy is the Covered Entity. Under **45 CFR § 164.502(e)(1)(i)**
a covered entity may not disclose PHI to a business associate without
satisfactory assurances in the form of a contract. Until that contract
exists, **no pharmacy customer may lawfully send PHI to Pharmax** — which
means no customer can onboard, regardless of how ready the software is.

This template is the Pharmax-paper version. Customers on their own paper are
handled per §8.

## 1. Definitions

Terms capitalised but not defined here take the meaning given in
**45 CFR Parts 160 and 164**. Where this Agreement and the Rules conflict,
the Rules control.

| Term                      | Meaning                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agreement**             | This Business Associate Agreement.                                                                                                                                |
| **Business Associate**    | Pharmax, Inc. ("Pharmax").                                                                                                                                        |
| **Covered Entity**        | The pharmacy identified in the signature block.                                                                                                                   |
| **Breach**                | As defined at **45 CFR § 164.402**.                                                                                                                               |
| **Electronic PHI / ePHI** | As defined at **45 CFR § 160.103**.                                                                                                                               |
| **HIPAA Rules**           | The Privacy, Security, Breach Notification and Enforcement Rules at 45 CFR Parts 160 and 164, as amended, including by the HITECH Act.                            |
| **Individual**            | As defined at **45 CFR § 160.103**, including a personal representative.                                                                                          |
| **PHI**                   | Protected Health Information as defined at **45 CFR § 160.103**, limited to information Pharmax creates, receives, maintains or transmits for the Covered Entity. |
| **Security Incident**     | As defined at **45 CFR § 164.304**.                                                                                                                               |
| **Services**              | The Pharmax pharmacy operating platform provided under the Master Services Agreement ("MSA") between the parties.                                                 |
| **Subcontractor**         | As defined at **45 CFR § 160.103**.                                                                                                                               |

## 2. Permitted uses and disclosures

_Satisfies **§ 164.504(e)(2)(i)**._

**2.1 Services.** Pharmax may use and disclose PHI only as necessary to
perform the Services, and only as consistent with this Agreement, the MSA
and the HIPAA Rules.

**2.2 Required by law.** Pharmax may use or disclose PHI as Required By Law
(**§ 164.103**).

**2.3 Management and administration.** Pharmax may use PHI for its own
proper management and administration and to carry out its legal
responsibilities (**§ 164.504(e)(4)(i)**). Pharmax may disclose PHI for
those purposes only if the disclosure is Required By Law, or Pharmax obtains
reasonable assurances from the recipient that the PHI will be held
confidentially, used or further disclosed only as Required By Law or for the
purpose for which it was disclosed, and that the recipient will notify
Pharmax of any breach of confidentiality (**§ 164.504(e)(4)(ii)**).

**2.4 Data aggregation.** Pharmax may use and disclose PHI to provide Data
Aggregation services relating to the Covered Entity's health care operations
(**§ 164.504(e)(2)(i)(B)**).

**2.5 De-identification.** Pharmax may de-identify PHI in accordance with
**§ 164.514(a)–(b)**. De-identified information is not PHI and this
Agreement does not restrict its use. _Counsel note: customers frequently
negotiate this clause. Whether Pharmax may use de-identified customer data
for product improvement or benchmarking is a **business** decision to make
deliberately before it appears on paper, not a boilerplate default._

**2.6 Minimum necessary.** Pharmax will limit its uses, disclosures and
requests to the minimum necessary to accomplish the intended purpose
(**§ 164.502(b)**, **§ 164.514(d)**).

**2.7 Prohibitions.** Pharmax will not use or disclose PHI in a manner that
would violate Subpart E of Part 164 if done by the Covered Entity
(**§ 164.504(e)(2)(ii)(H)**), and will not sell PHI or use or disclose it
for marketing or fundraising except as permitted by the HIPAA Rules and
authorised in writing by the Covered Entity.

## 3. Obligations of Pharmax

_Each subsection maps to **§ 164.504(e)(2)(ii)**._

**3.1 Limits on use and disclosure** — _(A)_. Pharmax will not use or
disclose PHI other than as permitted by this Agreement or as Required By
Law.

**3.2 Safeguards** — _(B)_. Pharmax will use appropriate administrative,
physical and technical safeguards, and will comply with Subpart C of Part
164 (the Security Rule) with respect to ePHI, to prevent use or disclosure
of PHI other than as provided for by this Agreement. Pharmax's safeguards
are described in the [Information Security Policy](../policies/information-security-policy.md)
and assessed in the [HIPAA Security Risk Analysis](../security/hipaa-security-risk-analysis.md).

**3.3 Reporting** — _(C)_. Pharmax will report to the Covered Entity:

1. any use or disclosure of PHI not provided for by this Agreement of which
   it becomes aware;
2. any Security Incident affecting ePHI of which it becomes aware; and
3. any Breach of Unsecured PHI, in accordance with **§ 164.410**.

Notification of a Breach will be made without unreasonable delay and in no
case later than **60 calendar days** after discovery, as § 164.410(b)
requires. Pharmax's internal target is **notification within 24 hours of
confirmation** ([Incident Response Policy §5.1](../policies/incident-response-policy.md)),
because the Covered Entity has its own downstream deadline under
**§ 164.404** and cannot meet it if Pharmax delays.

The notification will include, to the extent known and as § 164.410(c)
requires, the identification of each Individual whose Unsecured PHI was or
is reasonably believed to have been accessed, acquired, used or disclosed,
and any other information the Covered Entity needs for its own notification
obligations. Pharmax will supplement the report as further information
becomes available.

_Counsel note: unsuccessful Security Incidents (routine port scans, blocked
authentication attempts, denied firewall traffic) are customarily addressed
by a standing aggregate notice rather than individual reports. Consider an
express provision; without one, § 164.314(a)(2)(i)(C) is sometimes read to
require reporting of every failed probe._

**3.4 Subcontractors** — _(D)_. In accordance with
**§ 164.502(e)(1)(ii)** and **§ 164.308(b)(2)**, Pharmax will ensure that
any Subcontractor that creates, receives, maintains or transmits PHI on
behalf of Pharmax agrees in writing to restrictions and conditions at least
as restrictive as those that apply to Pharmax under this Agreement.

> **BLOCKING PRECONDITION.** This clause is a representation about executed
> paper, not about intent. Pharmax's Subcontractors that receive PHI or
> ciphertext include AWS (Aurora, S3, KMS, ECS, CloudWatch Logs) and
> EasyPost (recipient addresses, which are PHI by linkage).
>
> As of 2026-08-18: **AWS and Sentry are `executed`**, and **EasyPost is
> being decommissioned** rather than signed (2026-08-17). Retiring it
> closes the last gap by removing the counterparty — it was a SaaS
> middleman storing addresses in its own platform, which is what made it a
> business associate. FedEx and UPS replace it directly under a **conduit
> determination** (HHS FAQ #245) with tenant-owned credentials, so they add
> no BAA obligation.
>
> So §3.4 becomes signable — but on a fact about production, not about
> intent. It is true once the EasyPost integration is **off in production**
> and counsel has concurred with the carrier conduit determination.
> Verify both against the [BAA tracker](./baa-tracker.md) before signature;
> that file is the record and this paragraph is a summary of it on one date.

**3.5 Individual right of access** — _(E)_. Pharmax will make PHI in a
Designated Record Set available to the Covered Entity as necessary to
satisfy the Covered Entity's obligations under **§ 164.524**.

Pharmax's role is to make the record retrievable by the Covered Entity's
authorised workforce through the operator console; the **Covered Entity**
responds to the Individual, because the Covered Entity is the Individual's
interface ([data-flow §6.5](../security/data-flow.md)). Pharmax will respond
to a Covered Entity request within **ten (10) business days**, which leaves
the Covered Entity margin inside its own 30-day statutory window.

**3.6 Amendment** — _(F)_. Pharmax will make PHI in a Designated Record Set
available to the Covered Entity for amendment, and will incorporate
amendments the Covered Entity directs, as necessary to satisfy
**§ 164.526**. Amendments are applied as append-only corrections that
preserve the prior value and the reason for the change; the audit record is
immutable by design and is not rewritten.

**3.7 Accounting of disclosures** — _(G)_. Pharmax will document
disclosures of PHI and information related to them, and will make that
information available to the Covered Entity, as necessary to satisfy
**§ 164.528**. Pharmax maintains a tamper-evident, hash-chained audit log
for this purpose.

**3.8 Covered Entity obligations** — _(H)_. To the extent Pharmax carries
out an obligation of the Covered Entity under Subpart E of Part 164, Pharmax
will comply with the requirements of Subpart E that apply to that
obligation.

**3.9 Availability to HHS** — _(I)_. Pharmax will make its internal
practices, books and records relating to the use and disclosure of PHI
available to the Secretary of Health and Human Services for purposes of
determining the Covered Entity's compliance with Subpart E. Pharmax will
notify the Covered Entity of such a request unless prohibited by law.

**3.10 Workforce** — Pharmax will train its workforce on its obligations
under this Agreement and will apply sanctions for violations
([Information Security Policy](../policies/information-security-policy.md),
[security training program](./security-training-program.md)).

**3.11 Mitigation** — Pharmax will mitigate, to the extent practicable, any
harmful effect known to it of a use or disclosure of PHI in violation of
this Agreement (**§ 164.530(f)** as applied through the BA relationship).

## 4. Obligations of the Covered Entity

**4.1** The Covered Entity will obtain any consent, authorisation or
permission required for Pharmax to use and disclose PHI as contemplated
here.

**4.2** The Covered Entity will notify Pharmax of any limitation in its
Notice of Privacy Practices, any change in or revocation of an Individual's
permission, and any restriction on use or disclosure agreed to under
**§ 164.522**, to the extent any of these affects Pharmax's use or
disclosure of PHI.

**4.3** The Covered Entity will not request Pharmax to use or disclose PHI
in a manner that would not be permitted under Subpart E if done by the
Covered Entity.

**4.4** The Covered Entity is solely responsible for the professional and
regulatory obligations of operating a pharmacy, including its pharmacy
licensure, DEA registration, designation of a pharmacist-in-charge, resident
and non-resident licensure for every jurisdiction it ships into, controlled
substance recordkeeping, PDMP reporting obligations, and the clinical
judgement exercised by its pharmacists. Pharmax provides software and does
not practise pharmacy.

> _Counsel note: §4.4 is the most commercially important clause in this
> document and belongs in the MSA as well. It is the line between a software
> vendor and an entity practising pharmacy without a licence. It also
> disclaims nothing Pharmax should be disclaiming about the software itself —
> keep clinical-decision-support limitations in the MSA, not here._

## 5. Term and termination

**5.1 Term.** This Agreement takes effect on the Effective Date and
continues until all PHI is returned or destroyed under §5.4, or until
terminated as provided below.

**5.2 Termination for cause by the Covered Entity** —
_**§ 164.504(e)(2)(iii)**_. If the Covered Entity determines that Pharmax
has materially breached this Agreement, the Covered Entity may provide
Pharmax an opportunity to cure within **thirty (30) days**; if cure is not
achieved, or if cure is not feasible, the Covered Entity may terminate this
Agreement and the MSA.

**5.3 Termination for cause by Pharmax.** Pharmax may terminate on the same
terms if the Covered Entity materially breaches §4.

**5.4 Return or destruction.** On termination, Pharmax will return or
destroy all PHI it maintains for the Covered Entity and retain no copies,
including PHI held by Subcontractors. Where return or destruction is
infeasible, Pharmax will notify the Covered Entity of the conditions making
it infeasible, will extend the protections of this Agreement to that PHI,
and will limit further uses and disclosures to the purposes that make return
or destruction infeasible, for as long as it retains the PHI
(**§ 164.504(e)(2)(ii)(J)**).

Pharmax will deliver an export of the Covered Entity's data in a
machine-readable format before destruction, and will provide a certificate
of destruction. Backup media follow their documented retention cycle; PHI in
immutable audit storage and in backups is retained for the periods stated in
the [Data Classification Policy](../policies/data-classification.md) and
protected under this section until expiry.

> _Counsel note: the retention carve-out must be truthful and specific.
> Object-Lock audit storage and 35-day backups genuinely cannot be
> selectively purged; say so plainly with the actual periods rather than
> using a vague "technically infeasible" formula an auditor will probe._

**5.5 Survival.** §5.4 and §6 survive termination.

## 6. Miscellaneous

**6.1 Regulatory references** are to the provision as amended from time to
time. **6.2 Amendment:** the parties will amend this Agreement as necessary
to comply with changes to the HIPAA Rules. **6.3 Interpretation:**
ambiguities are resolved to permit compliance with the HIPAA Rules.
**6.4 No third-party beneficiaries.** **6.5 State law:** where state law
affords Individuals greater protection, the parties will comply with it; see
the state addendum at §9. **6.6 Order of precedence:** this Agreement
controls over the MSA as to PHI. **6.7 Counterparts and electronic
signature.** **6.8 Governing law:** [Governing law: TBD].
**6.9 Independent obligations:** liability, indemnity, insurance and
limitation-of-liability terms are governed by the MSA and are deliberately
not restated here.

> _Counsel note: customers will often try to import uncapped indemnity for
> PHI breaches through the BAA. Keeping liability in the MSA — with one
> negotiated position — prevents the same risk being priced twice on two
> pieces of paper._

## 7. Preconditions — do not sign while any of these is false

Each row is a factual representation this Agreement makes. Verify before
signature; a false representation here is materially worse than a missing
feature.

| #   | Representation                                                          | Clause | Status                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Subcontractor BAAs are executed with every PHI-touching vendor          | §3.4   | **PENDING TWO FACTS** — AWS and Sentry `executed`; EasyPost decommissioning; FedEx/UPS conduit. True once (a) EasyPost is off in **production** and (b) counsel concurs on the conduit determination. |
| 2   | A Covered Entity can retrieve an Individual's record set on request     | §3.5   | **PARTIAL** — operator console is the retrieval path; there is no export producer, so a request is served by hand today.                                                                              |
| 3   | Disclosure accounting is queryable per patient for the § 164.528 period | §3.7   | **VERIFY** — the audit log is hash-chained and complete; confirm a per-Individual disclosure query exists and is scoped.                                                                              |
| 4   | Tenant data export and purge exist for the termination path             | §5.4   | **VERIFY** — needed before signing §5.4. Confirm a per-tenant export and purge routine exists and has been exercised once.                                                                            |
| 5   | Workforce security training is delivered and attested                   | §3.10  | **VERIFY** — the program document exists; confirm attestations are on file for everyone with production access.                                                                                       |
| 6   | Breach notification can be executed within the 24-hour internal target  | §3.3   | **VERIFY** — depends on alarms reaching a human. Confirm a subscribed, confirmed on-call endpoint exists.                                                                                             |

Rows 1 and 2 are the two that change what the paper may say. Row 1 is
procurement; row 2 is roughly a week of engineering, or a narrowing of §3.5
to what the console actually does.

## 8. When the customer insists on their own paper

Larger pharmacy groups will present their own BAA. That is normal and
usually acceptable. Review against this checklist and escalate to counsel on
any hit:

- **Breach notification shorter than 24 hours** from discovery (not
  confirmation), or requiring notice of every unsuccessful Security
  Incident. Both are operationally unmeetable at current staffing.
- **Audit rights** permitting on-site inspection on short notice, or
  security questionnaires without a frequency cap.
- **Uncapped indemnity** or breach-related liability outside the MSA cap.
- **Data-return obligations** that ignore immutable audit storage and backup
  retention — commit to something the architecture can actually do.
- **Prohibitions on de-identified use** broader than intended, if any
  product-analytics use is planned.
- **Choice of law or venue** inconsistent with the MSA.
- **Flow-down obligations** stricter than what Pharmax's own upstream BAAs
  provide. Pharmax cannot promise assurances it has not obtained.

Record every executed customer BAA — on either paper — in the
[customer BAA register](./customer-baa-register.md).

## 9. State addendum

[State addendum: TBD]. Several states impose obligations beyond HIPAA on
pharmacy records and breach notification, and a few regulate mail-order and
non-resident pharmacy practice in ways that reach the vendor's records.
Populate per launch jurisdiction with counsel; the
[Incident Response Policy §5.2](../policies/incident-response-policy.md)
state-notification matrix is the companion artifact and is likewise
outstanding.

## 10. Signatures

| Covered Entity                | Business Associate        |
| ----------------------------- | ------------------------- |
| Entity: ********************* | Entity: Pharmax, Inc.     |
| By: *********************     | By: ********************* |
| Name: *******************     | Name: ******************* |
| Title: ******************     | Title: ****************** |
| Date: *******************     | Date: ******************* |

## Cross-references

- [baa-tracker.md](./baa-tracker.md) — the upstream direction; §3.4 depends on it.
- [customer-baa-register.md](./customer-baa-register.md) — executed customer BAAs.
- [Vendor Management Policy](../policies/vendor-management-policy.md) — establishes Pharmax's BA posture.
- [Incident Response Policy §5](../policies/incident-response-policy.md) — the §3.3 procedure.
- [HIPAA Security Risk Analysis](../security/hipaa-security-risk-analysis.md) — the §3.2 assessment.
- [data-flow.md](../security/data-flow.md) — PHI ingress and egress paths.
- HIPAA 45 CFR § 164.308(b), § 164.314(a), § 164.402, § 164.404, § 164.410, § 164.502(e), § 164.504(e), § 164.524, § 164.526, § 164.528.
