# Customer BAA Register — executed agreements with Covered Entities

| Field          | Value                       |
| -------------- | --------------------------- |
| Owner          | [Owner: CTO]                |
| Approver       | [Approver: CEO]             |
| Effective date | [Effective date: TBD]       |
| Last reviewed  | [Last reviewed: YYYY-MM-DD] |
| Next review    | [Next review: YYYY-MM-DD]   |
| Version        | 0.1                         |
| Distribution   | Internal — All staff        |

This register records every Business Associate Agreement under which a
pharmacy customer discloses PHI to Pharmax. It is the **downstream**
counterpart to the [BAA tracker](./baa-tracker.md), which records the
upstream agreements Pharmax holds with its own vendors.

Under **45 CFR § 164.502(e)(1)(i)** a Covered Entity may not disclose PHI to
a Business Associate without a contract providing satisfactory assurances.
The controlling rule for Pharmax is therefore:

> **No tenant organization may be provisioned for production PHI until its
> BAA status here is `executed`.**

A tenant onboarded without an executed BAA is a compliance event on the
customer's side and a contract-formation failure on ours. It is treated as
SEV2 under [Incident Response Policy §3](../policies/incident-response-policy.md),
on the same footing as PHI flowing to a vendor without a BAA.

## Status vocabulary

The same controlled vocabulary as the upstream tracker, so a reader does not
have to hold two schemes in mind:

- **`not requested`** — commercial conversation only. No PHI. Tenant must
  not be provisioned in production.
- **`requested`** — terms with the customer's counsel. Still no PHI.
- **`executed`** — signed by both parties and on file. Production
  provisioning may proceed.
- **`terminated`** — engagement ended; §5.4 return-or-destroy performed;
  destruction certificate on file. Row retained for the audit trail.

## Register

No customer BAA has been executed. The template that produces them is at
[customer-baa-template.md](./customer-baa-template.md) and is **draft,
pending counsel review** — so the correct count today is zero, and this
table stays empty rather than carrying a placeholder row that would read as
progress.

When the first is executed, record it with these columns:

| Column           | Content                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Customer         | Legal entity name of the Covered Entity                                                    |
| `organizationId` | The Pharmax tenant UUID the agreement authorises — the link between paper and provisioning |
| Paper            | `Pharmax template` or `Customer paper` (record the deviations reviewed under template §8)  |
| BAA status       | Controlled vocabulary above                                                                |
| Effective date   | Date both signatures are in place                                                          |
| Review date      | Typically 12 months from execution                                                         |
| Jurisdictions    | States the customer dispenses into — drives the template §9 state addendum                 |
| Owner            | CTO                                                                                        |
| Evidence         | `evidence/baa/customers/<slug>/<YYYY-MM>-baa-executed.pdf`                                 |

## Onboarding gate

The BAA is a step in tenant provisioning, not a parallel track. Sequence:

1. MSA executed.
2. **BAA executed** on Pharmax template, or on customer paper reviewed
   against template §8. Status here flips to `executed`; PDF filed.
3. Customer's pharmacy credentials collected and recorded — state licence
   number and expiry, DEA registration, NPI, NCPDP/NABP identifier, and the
   jurisdictions each site is licensed to dispense into. These are the
   customer's licences, not Pharmax's; Pharmax records and enforces against
   them.
4. Tenant organization, sites, clinics, buckets and roles bootstrapped.
5. Production PHI may flow.

Step 2 gates step 5 absolutely. Step 3 has no schema home today —
`PharmacySite` carries no licence, DEA, NPI or NCPDP fields — which is
tracked as a product gap, not a paperwork one.

## Quarterly cross-reference check

During each quarterly access review
([access-review-procedure.md](./access-review-procedure.md)), the CTO
reconciles this register against the tenant list in production:

- Every `organization` row carrying PHI must map to a register row with
  status `executed`.
- Every register row with status `executed` should map to a live tenant, or
  carry a note explaining why not.
- A tenant with PHI and no executed BAA is an immediate SEV2 finding.

This mirrors the upstream check in
[baa-tracker.md](./baa-tracker.md#quarterly-cross-reference-check), which
reconciles integration switches against vendor BAA status. Same control,
opposite direction.

## Cross-references

- [customer-baa-template.md](./customer-baa-template.md) — the agreement itself.
- [baa-tracker.md](./baa-tracker.md) — upstream vendor BAAs. Template §3.4 cannot be truthfully signed until those are executed.
- [Vendor Management Policy §1](../policies/vendor-management-policy.md) — establishes Pharmax as a Business Associate of its customers.
- HIPAA 45 CFR § 164.502(e)(1)(i), § 164.504(e).
