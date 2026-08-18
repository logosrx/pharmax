# Playbook: Vendor BAA Execution

| Field                | Value                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Controls satisfied   | HIPAA §164.308(b)(1), §164.314(a)(1)–(2); SOC 2 CC9.2-1                                                    |
| Cadence              | One-time execution sprint, then on-event (new PHI-touching vendor, or an existing vendor's scope changing) |
| Owner                | CTO                                                                                                        |
| Reviewers            | Security Officer (PHI scope per vendor), Compliance Officer (tracker + evidence)                           |
| Final sign-off       | CEO (contract execution authority)                                                                         |
| Evidence destination | `evidence/baa/<vendor>/<YYYY-MM>-baa-executed.pdf`                                                         |

## Purpose

Move every PHI-touching vendor from `[BAA status: TBD]` to `executed`.

This is the one-time sprint that clears the gate. The recurring
counterpart is [`vendor-risk-review.md`](./vendor-risk-review.md),
which re-confirms annually that the instruments are still in place and
that the inventory still matches what the code actually calls. This
playbook produces the evidence that playbook later samples.

## Why this blocks everything else

§164.308(b)(1) permits a covered entity or business associate to let a
subcontractor create, receive, maintain, or transmit PHI on its behalf
**only after** obtaining satisfactory assurances, in a contract, that
the subcontractor will safeguard it. There is no maturity gradient
here and no partial credit: either the contract exists before the data
moves, or the disclosure was impermissible.

[`baa-tracker.md`](../../governance/baa-tracker.md) already states the
operating rule correctly:

> A BAA-required vendor whose status is not `executed` must not
> receive PHI.

When this playbook was written, every PHI-touching row in that tracker
read `[BAA status: TBD]` — the rule was right and nothing satisfied it.
AWS has since been executed (below). The tracker file itself still needs
updating to say so, which is the bookkeeping step this playbook closes.

## Tier 0 — self-service, no vendor contact required

### AWS — EXECUTED 2026-08-17

**Scope of PHI:** all of it. Encrypted patient columns and blind
indexes in Aurora PostgreSQL, documents and package photos in S3, the
audit archive, data keys in KMS, application memory in ECS/Fargate,
connection secrets in Secrets Manager, and anything reaching CloudWatch
Logs. If AWS is not covered, nothing is.

**Status:** the AWS Organizations Business Associate Addendum was
accepted on 2026-08-17 at the **Organization** level, so it covers the
management account and every member account — including accounts joined
after the effective date, per the addendum's own `Member Account`
definition. The AWS Organizations HCLS BAA Addendum was accepted at the
same time.

Coverage is bounded by the addendum's definition of PHI: information
_"received by AWS from or on behalf of you and that is in a HIPAA
Account."_ PHI placed in any AWS account outside this Organization is
not covered.

The executed PDF is `AMAZON CONFIDENTIAL` and subject to the AWS
Artifact NDA. File it under `evidence/` — which is gitignored — never
in source control, and do not reproduce its clauses in policy
documents. For customer security reviews, attest that an AWS BAA is
executed and give the date; do not redistribute AWS's paper.

The steps below are retained for the next account or organization.

**Scope of PHI:** all of it. Encrypted patient columns and blind
indexes in Aurora PostgreSQL, documents and package photos in S3, the
audit archive, data keys in KMS, application memory in ECS/Fargate,
connection secrets in Secrets Manager, and anything reaching CloudWatch
Logs. If AWS is not covered, nothing is.

**This is self-service and free.** There is no sales cycle, no
negotiation, and no lead time — which makes it the single highest
value-per-minute item in the entire compliance programme.

1. Sign in to the AWS Management Console.
2. Open **AWS Artifact** (search "Artifact" in the services bar).
3. Go to **Agreements**.
   - Single account: use the **Account agreements** tab.
   - Using AWS Organizations: accept from the **management account**
     under **Organization agreements**, which covers current _and
     future_ member accounts. Only the management account can do this.
4. Select **AWS Business Associate Addendum**, review the terms, tick
   the acceptance box, and accept.
5. The BAA is effective immediately and applies account-wide.

**Then do the part people skip.** The BAA covers only AWS's published
**HIPAA-eligible services**. Running PHI on a non-eligible service is a
violation _even with the BAA accepted_. Walk the Pharmax estate against
the current eligible-services list at
<https://aws.amazon.com/compliance/hipaa-compliance/> — the list
changes, so check it rather than trusting this file.

Services in the Terraform estate that touch PHI or PHI-derived data:

| Module              | Service                                     | Carries PHI?                                     |
| ------------------- | ------------------------------------------- | ------------------------------------------------ |
| `rds`               | Aurora PostgreSQL                           | Yes — the primary store                          |
| `s3-documents`      | S3                                          | Yes — documents, package photos                  |
| `s3-audit-archive`  | S3                                          | Yes — audit evidence                             |
| `kms`               | KMS                                         | Yes — wraps every data key                       |
| `ecs`               | ECS / Fargate                               | Yes — plaintext in process memory                |
| `secrets`           | Secrets Manager                             | Credentials, not PHI                             |
| `elasticache`       | ElastiCache                                 | Yes — cache may hold decrypted values            |
| `cloudfront`        | CloudFront                                  | Yes — serves PHI-bearing responses               |
| `alb`               | Elastic Load Balancing                      | Yes — terminates PHI-bearing requests            |
| `ecr`               | ECR                                         | No — images only                                 |
| `cloudwatch`        | CloudWatch Logs                             | Should not, but is the likeliest accidental path |
| `security-baseline` | CloudTrail, Config, GuardDuty, Security Hub | Metadata only                                    |
| `synthetics`        | CloudWatch Synthetics                       | No — canaries use synthetic data                 |

**Evidence:** AWS Artifact shows the accepted agreement and its
acceptance date. Export or screenshot it to
`evidence/baa/aws/<YYYY-MM>-baa-executed.pdf`, and record which
account or organization it was accepted under.

## Tier 1 — blocking, requires vendor outreach

### Sentry

**Scope of PHI:** intended to be none. The tracker records the BAA as a
"belt-and-braces" measure on the basis that Sentry receives only
redacted contexts.

**That basis is weaker than the tracker assumes.** The server-side
scrubber is genuinely good — allowlisted extras, request bodies, query
strings and headers stripped, `sendDefaultPii: false`, user context
reduced to an id. But three gaps remain open today:

- Exception **messages** are length-capped, not scrubbed
  (`apps/web/src/server/observability/sentry-scrubber.ts`).
- Carrier adapters preserve vendor error text, which can echo the
  address that was submitted (`packages/shipping/src/carriers/`).
- The **browser** and **edge** Sentry configs have no custom
  `beforeSend` at all, only Sentry's defaults.

Until those close, treat Sentry as PHI-reachable and the BAA as
load-bearing rather than precautionary.

## Shipping carriers — a determination, not a request

Pharmax integrates **directly with FedEx**; the EasyPost aggregator is
being removed. That change subtracts a BAA obligation rather than
adding one, and the reason is worth stating precisely, because the
intuition ("we ship PHI, so the shipper needs a BAA") gets it backwards.

**EasyPost needed a BAA because it was a SaaS middleman, not because
shipping involves PHI.** It received recipient names and addresses into
its own platform and stored them. That is persistent access, which
makes a vendor a business associate.

**A carrier moving a sealed parcel is a conduit.** HHS FAQ #245 is
directly on point:

> the Privacy Rule does not require a covered entity to enter into
> business associate contracts with organizations, such as the US
> Postal Service, certain private couriers and their electronic
> equivalents that act merely as conduits for protected health
> information.

The HIPAA Omnibus Rule preamble names FedEx, UPS and DHL as examples.
A conduit transports information without accessing it other than on a
random or infrequent basis as necessary to perform the transport.

### Why this is a determination and not an assumption

The conduit exception is **narrow**, and whether it applies is a legal
call rather than an engineering one. Two facts make the Pharmax case
less clean than a paper mail carrier, and both belong in the record:

- Addresses are transmitted through FedEx's **API**, not written on an
  envelope.
- FedEx **retains tracking and signature records persistently**, where
  the exception contemplates storage that is transient and incidental.

The mainstream position in pharmacy logistics is that carriers remain
conduits regardless, and HHS has not retracted FAQ #245. That is very
likely right. It is still a position, and a position that is written
down with its reasoning survives an audit while an assumption does not.

**Tenant-owned credentials strengthen it further.** Each pharmacy
brings its own FedEx account via `carrier_credential`, so the tenant is
the shipper of record and the carrier relationship runs between the
tenant and FedEx. Pharmax transmits on the tenant's behalf, as that
tenant's business associate, using that tenant's credentials — it never
interposes itself as a party to the carrier relationship. The
conduit determination therefore sits with the covered entity, which is
where it belongs, and the customer-facing BAA should say so.

### What to record

Set the FedEx and UPS rows to `N/A — not a BA` with this rationale, a
citation to HHS FAQ #245, and counsel's concurrence noted. Do not leave
them blank and do not leave them `TBD`; an assessor will ask how the
conclusion was reached, and "we never sent them a BAA request" is not
an answer.

If FedEx signature services are used for controlled substances, note
that too. Signature capture is still incidental to delivery, but it is
the first thing an assessor probes after accepting the conduit
argument.

Re-open this determination if the integration ever stores PHI **in** a
carrier system beyond what a label and its tracking require, or if a
carrier value-added service starts processing rather than transporting.

## Tier 2 — not blocking today, but gate before enabling

### Resend and Twilio

**Neither receives PHI today, and that is enforced structurally, not by
convention.** Both channels report `phiCapable: false`, and the
notification registry's `assertNoPhiInContext` gate rejects any context
payload whose top-level keys match the PHI sentinel list
(`apps/worker/src/notifications/resend-notification-channel.ts:119`,
`apps/worker/src/notifications/twilio-sms-notification-channel.ts:128`).

So these are **not** go-live blockers. They become blockers the moment
anyone wants patient-facing email or SMS that names a person or their
medication. Obtain the BAA _before_ flipping `phiCapable` to `true`,
and treat that flag flip as the trigger — not the calendar.

Both vendors gate BAAs behind particular plan tiers, and those tiers
change. Confirm the current requirement when you raise the request
rather than budgeting from this file.

## Tier 3 — confirm the negative and record it

These need no BAA, but "no BAA needed" is a conclusion that must be
written down with its reasoning, not left as a blank.

| Vendor          | Position                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stripe**      | Out of PHI scope by design — invoice lines and descriptions carry org and clinic ids, never patient identifiers. Re-confirm whenever invoice content changes.                                                                                                                                                   |
| **GitHub**      | No PHI in source. Fixtures are synthetic (`check:seed` enforces this in CI).                                                                                                                                                                                                                                    |
| **1Password**   | Workforce credentials only. Confirm no PHI is stored as attachments.                                                                                                                                                                                                                                            |
| **FedEx / UPS** | Direct integration with tenant-owned credentials. Conduit exception applies — see "Shipping carriers" above for the determination and what must be recorded. Not a request; a documented conclusion.                                                                                                            |
| **EasyPost**    | Being removed. It was a business associate because it stored addresses in its own platform, so decommission it under the Vendor Management Policy termination steps: engineering switch off, return-or-destroy exercised, destruction certificate filed, status `terminated`, row retained for the audit trail. |
| **Vercel**      | The Terraform estate deploys `apps/web` to ECS behind ALB and CloudFront, so Vercel appears unused. Confirm, then record `N/A — not a BA` with that rationale, or execute a BAA if it is in fact in the path.                                                                                                   |

## Two inventory gaps to close first

**Grafana Cloud is not inventoried at all.** Commit `3989a17` wired a
Grafana Cloud OTel backend (opt-in), and the vendor appears in neither
[`vendor-inventory.md`](../../governance/vendor-inventory.md) nor
[`baa-tracker.md`](../../governance/baa-tracker.md).

It deserves more attention than a routine observability vendor,
because `packages/telemetry` has **no PHI scrubbing layer** — it
forwards caller-supplied span attributes verbatim and records raw
exception messages onto spans, with Node auto-instrumentation enabled
and no scrub hook. An OTel pipeline with no redaction is a plausible
PHI egress path, so either execute a BAA or keep the exporter disabled
until one exists. Add the row either way; a vendor that is missing from
the inventory cannot be reviewed.

**The Datadog-or-Honeycomb row is a placeholder for a vendor that was
never selected.** Either select one and pursue its BAA, or delete the
row. A permanently unresolved row trains readers to skim past `TBD`,
which is how the ones that matter get skimmed past too.

## Request emails

Send from a company address. Fill the bracketed fields. Keep the PHI
scope sentence — it is what routes the request to the right team and
prevents a second round-trip.

There is deliberately no carrier email here. FedEx and UPS are handled
by the determination above, not by a request — sending a BAA request to
a conduit invites a "we don't sign those" reply that reads, later, like
a refusal rather than a category error.

### Sentry

> **Subject:** HIPAA BAA request — [Company legal name] ([org slug])
>
> Hello,
>
> We use Sentry for error monitoring on a healthcare platform subject
> to HIPAA. Our configuration is designed so that no Protected Health
> Information reaches Sentry — request bodies, query strings and
> headers are stripped, `sendDefaultPii` is disabled, and user context
> is reduced to an opaque id.
>
> Because residual exposure through exception messages cannot be fully
> excluded, we require a Business Associate Agreement as a safeguard.
> Could you confirm BAA availability for our current plan and send the
> agreement, or tell me what plan level is required?
>
> Organization: [org slug]. Current plan: [plan].
>
> Thanks,
> [Name], [Title], [Company]

### Resend

> **Subject:** HIPAA BAA availability — [Company legal name]
>
> Hello,
>
> We use Resend for transactional email from a healthcare platform
> subject to HIPAA. Our current templates are deliberately PHI-free,
> but we are planning patient-facing notifications that would include
> identifying information.
>
> Before we enable those, we need an executed Business Associate
> Agreement. Could you confirm whether a BAA is available on our plan
> and what the process is?
>
> Account: [account email]. Current plan: [plan].
>
> Thanks,
> [Name], [Title], [Company]

### Twilio

> **Subject:** HIPAA BAA request — [Company legal name] (Account [SID])
>
> Hello,
>
> We use Twilio Programmable SMS from a healthcare platform subject to
> HIPAA. Current message templates are PHI-free by design, and we plan
> to introduce patient-facing messages that would reference an
> individual and their order.
>
> Before enabling those, we need a Business Associate Agreement and
> confirmation of which Twilio products are covered under it. Could you
> point me at the right process?
>
> Account SID: [SID]. Products in use: [Programmable SMS, ...].
>
> Thanks,
> [Name], [Title], [Company]

### Grafana Cloud

> **Subject:** HIPAA BAA availability — [Company legal name]
>
> Hello,
>
> We are evaluating Grafana Cloud as an OpenTelemetry backend for a
> healthcare platform subject to HIPAA. Telemetry may include span
> attributes and exception messages originating from systems that
> process Protected Health Information.
>
> Could you confirm whether Grafana Cloud offers a Business Associate
> Agreement, and on which plans? We will not enable the exporter
> against production until one is executed.
>
> Organization: [org]. Plan under consideration: [plan].
>
> Thanks,
> [Name], [Title], [Company]

## Filing and closing the loop

`evidence/` is **gitignored** and deliberately never committed — see
`.gitignore` and [`evidence-inventory.md`](../evidence-inventory.md).
Executed BAAs carry counterparty signatures and belong in the operator
evidence store, not in source control. The repository records _where_
the evidence lives and _what state_ it is in; it does not hold the PDFs.

For each vendor, in order:

1. File the executed PDF at
   `evidence/baa/<vendor>/<YYYY-MM>-baa-executed.pdf`.
2. Update the vendor's row in
   [`baa-tracker.md`](../../governance/baa-tracker.md): status to
   `executed`, plus the BAA effective date and the next review date
   (typically 12 months out).
3. Confirm the vendor also appears in
   [`vendor-inventory.md`](../../governance/vendor-inventory.md) with
   its PHI scope described.
4. Only then enable the engineering switch for any PHI flow to that
   vendor.

Step 4 is the one with teeth. Steps 1–3 are bookkeeping; step 4 is the
control.

## Definition of done

- [x] **AWS BAA accepted in Artifact — done 2026-08-17**, at the
      Organization level, covering the management account and every
      current and future member account. The HCLS addendum was accepted
      alongside it.
- [ ] AWS evidence filed to `evidence/baa/aws/2026-08-baa-executed.pdf`
      and the tracker row set to `executed`. Note the HCLS addendum as
      its own line — it authorises Amazon Connect de-identification for
      service improvement, which is inert while Connect is unused but
      is a granted permission either way.
- [ ] Pharmax services confirmed against the current HIPAA-eligible
      list, and confirmed no workload runs on AWS Outposts, which the
      addendum excludes from eligibility.
- [ ] Sentry BAA executed and filed. **This is now the only outreach
      BAA outstanding.**
- [ ] FedEx and UPS recorded as `N/A — not a BA` with the conduit
      determination, the HHS FAQ #245 citation, and counsel's
      concurrence.
- [ ] EasyPost decommissioned under the Vendor Management Policy
      termination steps; status `terminated`, row retained.
- [ ] Grafana Cloud added to the vendor inventory and BAA tracker, and
      either covered by a BAA or its exporter confirmed disabled.
- [ ] Datadog-or-Honeycomb row either resolved to a selected vendor or
      removed.
- [ ] Resend and Twilio BAA status recorded, with the `phiCapable`
      flag flip named as the trigger that makes them mandatory.
- [ ] Tier 3 negatives confirmed and written down with reasoning —
      Stripe, GitHub, 1Password, Vercel.
- [ ] No PHI-touching row in `baa-tracker.md` still reads
      `[BAA status: TBD]`.
