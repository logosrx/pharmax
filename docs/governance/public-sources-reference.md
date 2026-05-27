# Public-Sources Reference

| Field          | Value                       |
| -------------- | --------------------------- |
| Owner          | [Owner: CTO]                |
| Approver       | [Approver: CEO]             |
| Effective date | [Effective date: TBD]       |
| Last reviewed  | [Last reviewed: YYYY-MM-DD] |
| Next review    | [Next review: YYYY-MM-DD]   |
| Version        | 0.1                         |
| Distribution   | Internal — All staff        |

This document is the **authoritative list of public sources** that Pharmax design decisions are derived from. The companion [clean-room development policy](./clean-room-development-policy.md) requires that every significant design decision — workflow rule, schema choice, integration boundary, state-machine transition — be traceable to a source listed here.

Two reasons to keep this list:

1. **Defensibility.** If the design is ever challenged, the project has a contemporaneous, dated record showing the design inputs were public.
2. **Faster decisions.** Engineers shopping for "how should refills work in the typing queue" or "what fields must appear on a vial label" get a curated jump-off point instead of a green-field search.

Citation style throughout the repo:

- Inline in code comments: `// Per USP <797> §3.6` or `// FHIR MedicationDispense.whenHandedOver`.
- In ADRs: a `Sources` heading listing the entries from this document used.
- In commit messages for substantive design changes: a `Refs:` trailer pointing to the section here.

If a source you used is not listed here, **add it before merging**. The list is a living document, owned by the CTO and updated continuously.

---

## 1. U.S. federal statutes and regulations

| Citation                                                            | Authoritative URL                                                                            | What we use it for                                                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 21 CFR Part 1300 — definitions                                      | <https://www.ecfr.gov/current/title-21/chapter-II/part-1300>                                 | Definitions used across our controlled-substance and DEA flows.                                                                                                     |
| 21 CFR Part 1304 — records and reports                              | <https://www.ecfr.gov/current/title-21/chapter-II/part-1304>                                 | Inventory and recordkeeping rules for Schedule II–V substances; informs `lot`, `dispense_event`, and `controlled_substance_log` retention and reporting.            |
| 21 CFR Part 1306 — orders for controlled substances                 | <https://www.ecfr.gov/current/title-21/chapter-II/part-1306>                                 | Schedule-specific prescription requirements (face-to-face, electronic, partial fills, refills); informs the `ControlledSubstanceSchedule` state machine.            |
| 21 CFR Part 1311 — EPCS                                             | <https://www.ecfr.gov/current/title-21/chapter-II/part-1311>                                 | Electronic Prescriptions for Controlled Substances technical requirements; informs identity-proofing, two-factor authentication, and digital-signature constraints. |
| Drug Supply Chain Security Act (DSCSA) — 21 USC § 360eee            | <https://www.fda.gov/drugs/drug-supply-chain-integrity/drug-supply-chain-security-act-dscsa> | Transaction history, transaction information, transaction statement requirements; informs `lot_chain_of_custody` and serialization handling.                        |
| HIPAA Privacy Rule — 45 CFR Part 160 and Subparts A & E of Part 164 | <https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-E>           | Minimum-necessary, uses and disclosures, accounting of disclosures; underpins our audit-log and PHI-access patterns.                                                |
| HIPAA Security Rule — 45 CFR Part 164 Subpart C                     | <https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C>           | Administrative, physical, and technical safeguards; the basis for our encryption, access-control, and audit-trail controls.                                         |
| HIPAA Breach Notification Rule — 45 CFR Part 164 Subpart D          | <https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-D>           | Breach-notification triggers and timelines; informs the incident-response policy and runbook.                                                                       |

## 2. State pharmacy practice rules

State Boards of Pharmacy publish administrative rules covering dispensing workflow, verification, recordkeeping, labeling, and supervision. Pharmax supports tenant-specific configuration so each pharmacy can comply with its own state's rules; the design accommodates the union of these.

Maintain a per-state inventory under `docs/compliance/state-pharmacy-rules/<state-code>.md` as customers are onboarded. Each file cites the state Board of Pharmacy URL, the relevant administrative code sections, and the date the inventory was last refreshed.

Starter set (the four most common states in the customer pipeline):

| State      | Board URL                         | Notes                                             |
| ---------- | --------------------------------- | ------------------------------------------------- |
| Florida    | <https://floridaspharmacy.gov/>   | Includes 64B16 Florida Administrative Code.       |
| Texas      | <https://www.pharmacy.texas.gov/> | Texas State Board of Pharmacy rules under TAC 22. |
| California | <https://www.pharmacy.ca.gov/>    | California Code of Regulations Title 16 §1700+.   |
| Ohio       | <https://www.pharmacy.ohio.gov/>  | Ohio Administrative Code 4729.                    |

## 3. Compendial and professional standards

| Citation                                                                       | Authoritative reference                                                  | What we use it for                                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USP General Chapter <795> Pharmaceutical Compounding — Nonsterile Preparations | USP-NF (subscription)                                                    | Non-sterile compounding workflow constraints; informs the typing/PV1/fill/FV gating for compounded preparations.                                          |
| USP General Chapter <797> Pharmaceutical Compounding — Sterile Preparations    | USP-NF (subscription)                                                    | Sterile compounding (including 503A/503B context); informs cleanroom, garbing, beyond-use-dating, and verification rules in the fill and FV stages.       |
| USP General Chapter <800> Hazardous Drugs — Handling in Healthcare Settings    | USP-NF (subscription)                                                    | Hazardous-drug handling requirements; informs personal-protective-equipment scans, lot segregation, and disposal logging.                                 |
| NABP Model Pharmacy Act and Model Rules                                        | <https://nabp.pharmacy/resources/regulations/model-act/>                 | A neutral, well-organized baseline for the union of state rules. Useful as a design-time check that our state-agnostic core can be mapped onto any state. |
| ASHP Guidelines on the Pharmacist's Role in Immunization, Compounding, etc.    | <https://www.ashp.org/pharmacy-practice/policy-positions-and-guidelines> | Practice guidelines that inform stage-by-stage role gating.                                                                                               |
| APhA Practice Guidelines                                                       | <https://www.pharmacist.com/practice/practice-resources>                 | Community pharmacy practice references.                                                                                                                   |

USP-NF is licensed; access is via the USP-NF subscription managed by the CTO. Source quotations in Pharmax docs reference the chapter and section without reproducing copyrighted text in bulk.

## 4. Data and interoperability standards

| Standard                                                            | URL                                                                                            | What we use it for                                                                                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HL7 FHIR R4 — `MedicationRequest`                                   | <https://hl7.org/fhir/R4/medicationrequest.html>                                               | Canonical model for inbound prescriptions; informs the `prescription` and `prescription_line` schemas and the intake-to-typing handoff.                                                    |
| HL7 FHIR R4 — `MedicationDispense`                                  | <https://hl7.org/fhir/R4/medicationdispense.html>                                              | Canonical model for the dispense record; informs `dispense_event`, label payloads, and shipment-to-patient mapping.                                                                        |
| HL7 FHIR R4 — `MedicationAdministration`                            | <https://hl7.org/fhir/R4/medicationadministration.html>                                        | Patient-administration tracking when relevant (LTC and 503B contexts).                                                                                                                     |
| HL7 FHIR R4 — `Patient`, `Practitioner`, `Organization`, `Location` | <https://hl7.org/fhir/R4/resourcelist.html>                                                    | Naming and field choices for patient, prescriber, clinic, pharmacy site, and workstation entities.                                                                                         |
| NCPDP SCRIPT (current version, vendor-licensed)                     | <https://www.ncpdp.org/Standards-Development/Standards-Information/SCRIPT-Standard>            | E-prescribing message structures (NewRx, RxFill, RxChangeRequest, CancelRx, RxRenewalRequest, etc.); informs the prescriber-pharmacy integration surface and the typing-stage event types. |
| NCPDP Telecommunication Standard (D.0)                              | <https://www.ncpdp.org/Standards-Development/Standards-Information/Telecommunication-Standard> | Pharmacy claim transactions (B1/B2/B3); informs claim-line schemas and reconciliation flows in the billing package.                                                                        |
| X12 270/271 — eligibility inquiry/response                          | <https://x12.org/products/transaction-sets>                                                    | Insurance eligibility checks during intake.                                                                                                                                                |
| X12 835 — claim payment / remittance advice                         | <https://x12.org/products/transaction-sets>                                                    | Payment posting and reconciliation in billing.                                                                                                                                             |
| X12 837 — health-care claim                                         | <https://x12.org/products/transaction-sets>                                                    | Optional medical-billing surface for 503B and LTC cases.                                                                                                                                   |
| HL7 v2 — ADT and ORM                                                | <https://www.hl7.org/implement/standards/product_brief.cfm?product_id=185>                     | LTC and hospital integrations that still speak v2.                                                                                                                                         |

## 5. Openly licensed implementations (read-with-attribution)

Reading openly licensed code is allowed when (a) the project's license is compatible with our use and (b) the provenance is recorded here.

| Project                                | License              | URL                                       | Notes                                                                                                                                   |
| -------------------------------------- | -------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| OpenEMR — pharmacy module              | GPL-3.0              | <https://github.com/openemr/openemr>      | Read-only reference for community-pharmacy workflows. We do not copy code; if a structural insight informs Pharmax, the ADR records it. |
| OpenMRS — Order / Drug Order modules   | MPL-2.0 + Apache-2.0 | <https://github.com/openmrs/openmrs-core> | Reference for the `MedicationRequest` → `MedicationDispense` lifecycle in production code.                                              |
| GnuHealth — pharmacy and stock modules | GPL-3.0+             | <https://www.gnuhealth.org/>              | Reference for inventory and lot-trace patterns.                                                                                         |

License compatibility check: Pharmax is closed-source SaaS. We may **read** GPL'd code for ideas and patterns, but we may not **copy** GPL'd code into Pharmax. Code copying from these sources is forbidden by the [clean-room policy §4.2](./clean-room-development-policy.md#42-naming-and-convention-copying).

## 6. Integration partner public documentation

These are our integration surfaces. Their public docs are authoritative for how we call them; nothing about Pharmax's design needs to come from a competitor that integrates the same partner.

| Partner                        | URL                                                                                              | Surface                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EasyPost                       | <https://docs.easypost.com/>                                                                     | Shipping label creation, rate shopping, tracking webhooks. Backed by `@pharmax/shipping`.                                                                |
| FedEx                          | <https://developer.fedex.com/>                                                                   | Direct integration alternative to EasyPost; tracking URL conventions.                                                                                    |
| UPS                            | <https://developer.ups.com/>                                                                     | Direct integration alternative to EasyPost.                                                                                                              |
| USPS                           | <https://developer.usps.com/>                                                                    | Address validation and rate / label APIs.                                                                                                                |
| Stripe                         | <https://docs.stripe.com/>                                                                       | Invoice, refund, payment-intent surfaces; backs `@pharmax/billing`.                                                                                      |
| Twilio                         | <https://www.twilio.com/docs>                                                                    | SMS notifications to patients (consent-gated; see `docs/policies/data-classification.md`).                                                               |
| Clerk                          | <https://clerk.com/docs>                                                                         | Identity provider; backs `@pharmax/rbac` and the operator-console session layer.                                                                         |
| AWS                            | <https://docs.aws.amazon.com/>                                                                   | KMS for envelope encryption, S3 for object storage, RDS for Postgres, Secrets Manager. Backed by `@pharmax/crypto` and the Terraform under `terraform/`. |
| Sentry                         | <https://docs.sentry.io/>                                                                        | Error tracking; backs `apps/web`, `apps/worker`, `apps/print-agent` Sentry init modules.                                                                 |
| Resend                         | <https://resend.com/docs>                                                                        | Transactional email (clinic notifications, password resets).                                                                                             |
| Zebra ZPL II Programming Guide | <https://www.zebra.com/content/dam/zebra/manuals/printers/common/programming/zpl-zbi2-pm-en.pdf> | Zebra Programming Language reference; backs `@pharmax/labels` and the print agent.                                                                       |

## 7. Public marketing and feature inventory

A vendor's marketing site is fair game as a **feature inventory** — what feature surface area exists in this product category. It is not a source of implementation.

| Source                                                | URL      | What we use it for                                                                                          |
| ----------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| Vendor marketing                                      | (varies) | Feature inventory only. Capture as "this product category supports X" — never "vendor V implements X as Y." |
| Vendor help-center articles (public-facing)           | (varies) | User-facing workflow descriptions — what the operator does, not how the system implements it.               |
| Vendor demo videos (public, e.g. YouTube)             | (varies) | UI surface area; pacing of clicks. Never used to mimic specific layouts or microcopy.                       |
| Pharmacy conference talks (ASHP Midyear, NCPA, NACDS) | (varies) | Domain-expert presentations on workflow design, productivity metrics, and emerging regulation.              |

When a marketing page is used as a citation, save a PDF of the page (with the date) under `evidence/clean-room/sources/<YYYY-Q#>/` so the reference is preserved even if the page changes.

## 8. Research and trade press

| Source                                                  | URL                                     | Notes                                         |
| ------------------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| Journal of the American Pharmacists Association (JAPhA) | <https://www.japha.org/>                | Peer-reviewed practice research.              |
| American Journal of Health-System Pharmacy (AJHP)       | <https://academic.oup.com/ajhp>         | Hospital and health-system pharmacy research. |
| Pharmacy Practice News                                  | <https://www.pharmacypracticenews.com/> | Trade press; useful for emerging-issue scans. |
| Drug Topics                                             | <https://www.drugtopics.com/>           | Trade press.                                  |

---

## 9. Workflow-stage → source map

A condensed map from each Pharmax workflow stage to the public sources that authorize it. Each row should be reflected in the corresponding stage's command-handler tests and ADRs.

| Pharmax stage                                                    | Defining sources                                                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RECEIVED`                                                       | HL7 FHIR `MedicationRequest`; NCPDP SCRIPT NewRx; state Pharmacy Practice Act intake requirements.                                                       |
| `TYPING_IN_PROGRESS` → `TYPED_READY_FOR_PV1`                     | State Board of Pharmacy data-entry standards; ASHP guidelines on technician scope; NCPDP SCRIPT field requirements.                                      |
| `PV1_IN_PROGRESS` → `PV1_APPROVED_READY_FOR_FILL`                | State Pharmacy Practice Act pharmacist-verification requirements; ASHP guidelines on prospective drug-utilization review; USP <795>/<797> as applicable. |
| `FILL_IN_PROGRESS` → `FILL_COMPLETED_READY_FOR_FINAL`            | State BoP compounding rules; USP <795>, <797>, <800> as applicable; manufacturer package-insert beyond-use-dating.                                       |
| `FINAL_VERIFICATION_IN_PROGRESS` → `..._APPROVED_READY_FOR_SHIP` | State BoP final-verification rules; ASHP guidelines; USP chapters as applicable.                                                                         |
| `READY_TO_SHIP` → `SHIPPED`                                      | DSCSA transaction information / history / statement; carrier API contracts (EasyPost, FedEx, UPS, USPS); state shipped-prescription notification rules.  |
| Exception state `PV1_REJECTED`                                   | State BoP rejection-with-reason requirements; ASHP DUR guidelines.                                                                                       |
| Exception state `FINAL_VERIFICATION_REJECTED`                    | State BoP final-verification documentation rules.                                                                                                        |
| Exception state `ON_HOLD`                                        | State BoP hold-and-reopen rules; clinical-hold operational practice (ASHP).                                                                              |
| Exception state `CANCELLED`                                      | State BoP cancellation-and-disposition rules; HIPAA accounting-of-disclosures (45 CFR § 164.528) where a partial dispense occurred.                      |
| Audit log on every transition                                    | HIPAA Security Rule § 164.312(b) audit controls; SOC 2 CC7.2; state BoP recordkeeping rules.                                                             |
| PHI encryption at rest                                           | HIPAA Security Rule § 164.312(a)(2)(iv) encryption; NIST SP 800-111.                                                                                     |
| Multi-tenant isolation                                           | HIPAA Security Rule § 164.308(a)(4) information-access management; SOC 2 CC6.                                                                            |

## 10. How to add a new source

1. Confirm the source is public, openly licensed, or a vendor partner doc.
2. Add the row in the appropriate section above with the URL and a one-line "what we use it for."
3. If the source is a website that can change, save a dated PDF under `evidence/clean-room/sources/<YYYY-Q#>/<slug>.pdf`.
4. Cite it from the code, ADR, or commit message where it was first used.

## Revision history

| Version | Date       | Author | Change                             |
| ------- | ---------- | ------ | ---------------------------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting with starter set. |
