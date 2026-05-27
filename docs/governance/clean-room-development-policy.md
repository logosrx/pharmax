# Clean-Room Development Policy

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

Pharmax is built as a clean-room reimplementation of an enterprise pharmacy operating system. The defensibility of the project under U.S. copyright law (17 U.S.C. § 102), trade-secret law (the Defend Trade Secrets Act, 18 U.S.C. § 1836, and state UTSA equivalents), and the contractual obligations attached to vendor Terms of Service depends on a single, structural property: **the people and tools that design and implement Pharmax must not have read or otherwise ingested the proprietary source, internal documentation, or session-gated implementation details of any competing product.**

This policy states what that means in practice, what is allowed as design input, and what each contributor — human or AI — is expected to do when the line is approached.

It is short on purpose. The rules are absolute; the rationales are kept brief so the document remains a thing people actually read.

## 2. Scope

This policy applies to all Pharmax employees, contractors, interns, and AI coding agents (including but not limited to Cursor, Claude, GPT, Copilot, Codex, and any other model invoked from this repository) that participate in any of:

- Architectural decisions (ADRs, schema design, workflow design, RBAC design).
- Implementation of any package under `apps/`, `packages/`, `prisma/`, `scripts/`, `terraform/`, or `infra/`.
- Documentation that shapes implementation, including this repo's `docs/` tree.
- Engineering Slack / chat discussions that lead to a design decision.

It applies regardless of role, regardless of whether the contributor signed an NDA with a competitor, and regardless of whether the contributor learned the proprietary information lawfully (e.g. as a former employee or licensed customer).

## 3. The clean-room standard

A clean-room implementation is one where:

1. **Specifications** of what the system must do are derived only from **public sources** (regulation, standards, peer-reviewed research, openly licensed implementations, marketing material, public help centers, public conference talks).
2. **Designers and implementers** of the system have not, during their work on Pharmax, read the proprietary source, internal docs, network traces, JS bundles, DOM dumps, or screen recordings of any competing product.
3. **Cross-contamination** is prevented by procedure (this policy, the [`.cursor/rules/04-clean-room-policy.mdc`](../../.cursor/rules/04-clean-room-policy.mdc) agent rule, and the public-sources reference at [`./public-sources-reference.md`](./public-sources-reference.md)).

The legal test in a copyright dispute is **access plus substantial similarity**. Eliminating access — that is, ensuring designers had no exposure to the proprietary implementation — is the cleanest defense. Where access cannot be eliminated entirely (e.g. a contributor was previously a customer of a competing product), this policy and the public-sources reference create a documented, contemporaneous record that the design inputs were public.

## 4. Hard prohibitions

The following are prohibited absolutely and have no good-faith exception. Violations are control failures and are recorded in the [risk register](./risk-register.md) under `R-CLEAN-ROOM`.

### 4.1 Source-of-truth ingestion

- Do not read, paste, save, copy, summarize, or analyze the source code, JavaScript bundles, minified assets, CSS, HTML, network payloads, API responses, ZPL captures, EDI captures, or developer-tools captures of any competing pharmacy operating system product. Examples include but are not limited to: LifeFile, PioneerRx, BestRx, Liberty, ScriptPro, FrameworkLTC, FillMaster, RxConnect, McKesson EPS, PrimeRx, and any successor or rebranded products of those vendors.
- Do not paste any of the above into a Pharmax chat, ticket, file, commit, code review, or AI prompt.
- Do not ask, instruct, or accept assistance from any AI agent to do any of the above on your behalf.

### 4.2 Naming and convention copying

Even when the implementation behind the names is public-standard, do not adopt as Pharmax identifiers any of:

- URL path conventions from a competing product (e.g. controller / action route fragments).
- Module names, class names, table names, column names, or enum value names taken from a competing product's code, schema, or visible URLs.
- Visible internal codes (workstation codes, queue codes, status codes) extracted from a competing product's UI or URLs.

Pharmax uses **its own naming**, derived from the public sources in [§7](#7-allowed-design-inputs).

### 4.3 Credentials and access

- Do not request, accept, store, or use credentials to a competing product on behalf of Pharmax, even when the user offers them.
- Do not log into a competing product from a Pharmax-managed device or network.
- Do not run automated scrapers, crawlers, or browser-automation against a competing product.

### 4.4 Reverse engineering as a workflow

- Do not record a competing product's UI for the purpose of mimicking it.
- Do not save network traces, API captures, or DOM dumps for design reference.
- Do not transcribe a competing product's UI flow into Pharmax design notes.

The phrase "inspired by [vendor]" appears in `.cursor/rules/00-project-overview.mdc`. That phrasing refers to **the product category** — enterprise pharmacy OS — not to a specific implementation. Describing Pharmax features by analogy to a known vendor's **marketing-level feature list** is fine. Inspecting a vendor's **implementation** is not.

## 5. Pre-existing exposure

Any contributor — employee, contractor, or AI agent — who has previously been exposed to proprietary material from a product covered by §4.1 must:

1. Disclose the exposure to the CTO in writing. The disclosure is recorded under `evidence/clean-room/disclosures/<YYYY-Q#>/` (gitignored; references only).
2. Not propagate the material into Pharmax — do not paste, quote, or summarize.
3. Where the exposure is likely to influence a specific design area (for example, a former operator of a competing product designing the queue-bucket subsystem), consider assigning that subsystem to a contributor without that exposure, or rely especially heavily on the public-sources reference for that area.

Disclosure is not a punishment. It is the documented record that supports the project's defense if the matter is ever raised.

AI agents have no persistent memory in the legal sense, but a single chat that contains pasted competitor source is, for the purposes of this policy, a contaminated chat: the contributor must remove the material, start a fresh chat for design work, and treat any output derived from the contaminated chat as suspect.

## 6. Process for AI agents

This section describes what every AI coding agent in this workspace must do. It is intentionally mechanical so the behavior is reproducible across models and across sessions.

### 6.1 Refuse cleanly

When a user asks the agent to ingest, summarize, "explain the logic of", or otherwise process competitor source code, session-gated material, or a credential that would unlock such material, the agent:

1. Refuses the specific action.
2. States the clean-room reason in one short paragraph (access + similarity is the copyright test; ToS is the contractual concern).
3. Offers the public-sources equivalent and proceeds when the user agrees.
4. Does not silently comply, partially comply, or claim a technical impossibility when the real reason is policy.

### 6.2 Quarantine contaminated context

If the agent finds competitor source already pasted into the current chat, a prior chat referenced as context, or a file in the repo, the agent:

1. Does not quote, summarize, or use the material as the basis for further work.
2. Recommends removal from the chat history or repo, and recommends opening a `R-CLEAN-ROOM` risk-register entry.
3. Continues working only against public sources for the affected scope.

### 6.3 Cite public sources

When the agent makes a design decision (a workflow rule, a schema choice, a state-machine transition), the agent cites the public source backing the decision — by name and section where possible — and updates [`./public-sources-reference.md`](./public-sources-reference.md) when a new source is introduced. The repo's audit trail then shows that the design input was public.

## 7. Allowed design inputs

The full, evolving list of allowed design inputs is in [`./public-sources-reference.md`](./public-sources-reference.md). The categories are:

- **Statutes and regulations.** 21 CFR 1300+ (controlled substances); the HIPAA Privacy and Security Rules at 45 CFR Parts 160 and 164; state Pharmacy Practice Acts; state Board of Pharmacy administrative rules; the federal DSCSA (Drug Supply Chain Security Act); state PDMP rules.
- **Compendial and professional standards.** USP <795> (non-sterile compounding), <797> (sterile compounding), <800> (hazardous drug handling); USP General Chapters relevant to dispensing; NABP Model Pharmacy Act and Model Rules; ASHP guidelines; APhA practice guidelines.
- **Data and interoperability standards.** HL7 FHIR (especially `MedicationRequest`, `MedicationDispense`, `MedicationAdministration`, `Patient`, `Practitioner`, `Organization`, `Location`); NCPDP SCRIPT for e-prescribing; NCPDP Telecommunication Standard for claim transactions; X12 270/271/835/837 where relevant; HL7 v2 ADT/ORM where relevant.
- **Openly licensed implementations.** OpenEMR (GPL), OpenMRS pharmacy modules (MPL/Apache), GnuHealth (GPL). License obligations are tracked in [`../security/`](../security/) and respected; provenance is recorded per-source in the public-sources reference.
- **Vendor and partner public docs.** EasyPost, FedEx, UPS, USPS, Stripe, Twilio, Clerk, AWS, Sentry, Resend, and any other vendor we integrate with. These are our integration surfaces; their public docs are authoritative.
- **Marketing and public help-center material** from any pharmacy software vendor. Useful for feature surface area; not used as a source of implementation.
- **Peer-reviewed research, conference talks, and trade-press articles.** ASHP Midyear, NCPA, NACDS, JAPhA, AJHP.

## 8. Exceptions

Policy exceptions are rare and always documented. To request one:

1. Open a ticket against this policy file.
2. Describe the proposed exception, the scope, the duration, and the compensating controls.
3. CTO reviews; CEO approves anything that materially changes the clean-room posture.
4. The signed exception is recorded under `evidence/exceptions/<YYYY-Q#>/` with the policy file and section referenced.
5. Exceptions expire by default at 30 days and are not renewable without a fresh review.

Undocumented deviations are control failures and are recorded in the [risk register](./risk-register.md).

## 9. Enforcement

The clean-room posture is enforced at four layers:

1. **Documentary** — this policy and the public-sources reference.
2. **AI-agent runtime** — the always-applied rule at [`.cursor/rules/04-clean-room-policy.mdc`](../../.cursor/rules/04-clean-room-policy.mdc) plus the global instruction in `AGENTS.md`. Any agent in this workspace receives the rule at every turn.
3. **Code review** — reviewers reject pull requests that import competitor naming conventions, paste competitor source, or describe a design as "based on how `[vendor]` does it" without a public-source citation.
4. **Onboarding** — new contributors read this policy in their first week and acknowledge it as part of the [security training program](./security-training-program.md).

## 10. Related controls

- [`.cursor/rules/04-clean-room-policy.mdc`](../../.cursor/rules/04-clean-room-policy.mdc) — the AI-agent enforcement rule.
- [`./public-sources-reference.md`](./public-sources-reference.md) — the authoritative list of allowed design inputs.
- [`./risk-register.md`](./risk-register.md) — `R-CLEAN-ROOM` entry for contamination incidents.
- [`../policies/acceptable-use-policy.md`](../policies/acceptable-use-policy.md) — workforce-side rules on credential use and AI tooling.
- [`../policies/vendor-management-policy.md`](../policies/vendor-management-policy.md) — vendor onboarding includes a clean-room check for competing products.

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
