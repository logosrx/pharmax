# 0037 — EPCS: controlled-substance schedules, prescriber signing, and the audited application boundary

- **Status:** Proposed — commitment 1 implemented ahead of acceptance
- **Date:** 2026-08-01
- **Deciders:** Platform team, Security officer, Pharmacist-in-charge, Compliance
- **Tags:** `compliance`, `controlled-substances`, `dea`, `epcs`, `security`, `authentication`, `schema`

## Context

Pharmax today has no controlled-substance awareness of any kind. The
gap is total, not partial:

- `Provider.deaNumber` exists as a nullable plaintext column validated
  only by shape (`/^[A-Z]{2}\d{7}$/`). There is no check-digit
  validation, no schedule authority, no registration expiration, no
  registered address, and no verification against any DEA source.
- No `ControlledSubstanceSchedule` concept exists anywhere. `Product`
  carries `ndc` / `name` / `strength` / `form`; `Prescription` carries
  `drugNdc`, `quantityAuthorized`, `daysSupply`, `refillsAuthorized`,
  `daw`. Nothing in the system can distinguish a Schedule II from an
  antibiotic, so no Part 1306 rule (refill prohibition, partial fill,
  multiple-prescription sequencing) can be enforced.
- `Prescription` has no provenance. Its doc comment calls it "a signed
  prescription written by a provider," but there is no signature, no
  attestation, no source-document hash, no eRx message reference, and
  no record of how the prescriber authorized it.
- `IntakeSourceKind` is `MANUAL | CSV | API | EHR_INTEGRATION |
TRANSFERRED_IN`. There is no e-prescribing network integration, so
  there is no channel on which a signed prescription could arrive.
- The provider portal (ADR-0033) is read-only for orders. `PortalAccount`
  is password-only — `PortalSignIn` states "MFA: deliberately none in
  v1." The WebAuthn work in ADR-0036 binds to operator `User` rows, not
  to `PortalAccount`.
- ADR-0033 explicitly scoped this out: NPPES registry matching is
  "professional-identifier verification, not IAL2 identity proofing…
  EPCS-grade proofing is explicitly out of scope."

The roadmap now calls for prescriber-side EPCS: prescribers composing
and signing Schedule II–V prescriptions in the Pharmax portal.

Three forces dominate the design, and all three come from the
regulation rather than from engineering preference.

**Pharmax would become two regulated applications at once.** 21 CFR
part 1311 subpart C defines two distinct application roles with two
distinct requirement sets: the _electronic prescription application_
(§§ 1311.100–1311.170, the practitioner side) and the _pharmacy
application_ (§§ 1311.200–1311.215). Pharmax is a pharmacy application
by nature. The moment the portal lets a prescriber sign, it is also an
electronic prescription application and inherits the whole first set.

**We cannot issue the signing credential ourselves.** § 1311.105(a)
requires the practitioner's two-factor credential to come from either
a credential service provider approved by GSA to conduct identity
proofing at NIST SP 800-63-1 Assurance Level 3 or above, or — for
digital certificates — a certification authority cross-certified with
the Federal Bridge CA at basic assurance or above. IdenTrust is an
example of the latter. § 1311.105(c) further requires the CSP or CA to
issue the credential over two separate channels. Identity proofing and
credential issuance are therefore _someone else's_ regulated function;
our job is to integrate, bind, and verify.

**Certification gates deployment, and re-gates it on every change.**
§ 1311.300(a) requires a third-party audit or DEA-approved
certification _before_ the application may be used to create, sign,
transmit, or process controlled-substance prescriptions, and again
"whenever a functionality related to controlled substance prescription
requirements is altered or every two years, whichever occurs first."
For a continuously deployed modular monolith this is the single most
consequential constraint in the whole regulation: the audited surface
must be small, explicitly bounded, and separately versioned, or every
routine deploy drags the CS surface back through audit.

Two further regulatory details cut against the existing architecture
and must be settled up front rather than discovered mid-build.

_Two-person logical access control._ § 1311.120(b)(4) with § 1311.125
requires that setting or changing permission to sign CS prescriptions
involve **two** individuals: one enters the grant, a second — who must
be a DEA registrant holding a two-factor credential — executes it, and
per § 1311.120(b)(5) that execution itself requires two-factor
authentication. At least two individuals must be designated per
registered location, at least one of them a registrant authorized to
prescribe. `@pharmax/rbac` grants permissions to a role held by one
principal; it cannot express a two-person commit or a
"grantee must be a DEA registrant" constraint.

_Immutability versus crypto-shred._ § 1311.120(b)(19) provides that any
alteration of Part 1306 information after signing cancels the
prescription. § 1311.305(b) requires two-year electronic retention, and
§ 1311.305(h) requires digitally signed records to be transferred with
their signature. But the signed payload necessarily contains PHI —
§ 1306.05(a) and § 1311.120(b)(9) require the patient's full name, drug,
strength, quantity, and directions. Today `planCryptoShred` nulls an
encrypted envelope on request, and `CryptoShredPatient` is unconditional.
A CS prescription inside its retention window cannot be shredded, so
the shred path must become retention-aware.

## Decision

**Build EPCS as a separately versioned, separately audited module —
`@pharmax/epcs` — that treats the practitioner's two-factor credential
as an externally issued artifact we verify, never mint; that signs with
an application key in a FIPS-validated module rather than the
practitioner's private key; and that models controlled-substance
schedules and two-person logical access control as first-class domain
concepts rather than RBAC permissions.**

Ten commitments follow.

### 1. Controlled-substance schedules land first, and independently

A `ControlledSubstanceSchedule` enum (`CII`, `CIII`, `CIV`, `CV`, plus
`NON_CONTROLLED`) on `Product` and denormalized onto `Prescription` at
creation, with the Part 1306 rules that depend on it: no refills on
Schedule II (§ 1306.12), partial-fill tracking, multiple-prescription
sequencing with earliest-fill dates, and the § 1304 recordkeeping and
perpetual-inventory surface. This slice is independently valuable, is
_not_ part of the audited EPCS boundary, and is a hard prerequisite —
nothing downstream can reason about a prescription it cannot classify.

**Implemented 2026-08-01, ahead of acceptance.** Building this
commitment first was the point of separating it: it carries no signing,
no identity proofing, and no logical access control, so it can land and
be useful whether or not the rest of this ADR is ever accepted. Shipped:
the enum plus `product.controlledSubstanceSchedule`,
`prescription.controlledSubstanceSchedule` (a snapshot — see below) and
`prescription.earliestFillDate` in migration
`20260801020000_controlled_substance_schedule`, and a pure
`@pharmax/controlled-substances` package holding the Part 1306
evaluators. Three decisions made during implementation that this ADR did
not anticipate:

- **Schedule I has no enum member.** Schedule I substances cannot be the
  subject of a prescription (§ 1308.11), so no dispensable record can
  legitimately carry the value. Modelling it would create a state every
  downstream guard has to defend against for no real case.
- **The schedule on `Prescription` is a point-in-time snapshot, not a
  cached join.** A substance can be rescheduled; an already-written
  prescription must keep being governed by the schedule in force when it
  was issued. The catalog row stays the source of truth for _new_
  prescriptions only.
- **Schedule V is not Schedule III/IV.** § 1306.22(a)'s five-refill and
  six-month caps name Schedules III and IV only, so `federalRefillCap`
  returns `null` for CV rather than 5, and an ordinary CV fill has no
  federal six-month bar — while § 1306.23(c)'s six-month bar _does_
  reach CV on a partial fill. This asymmetry is pinned by test because
  it is the easiest part of Part 1306 to get quietly wrong. State
  overlays, which are frequently stricter, stay out of the federal
  module.

**Enforcement point: `CompleteFill`.** The rules bite at the moment the
drug actually leaves the pharmacy, not at order intake. An order can sit
for days before it is filled, and every clock Part 1306 defines — the
earliest-fill date, the six-month horizons, the 72-hour partial-fill
window — is evaluated against the instant of supply. Validating at
intake would produce an answer that is stale by the time it matters.
Evaluation runs BEFORE the scan and label-print checks: if a fill is
unlawful today, no amount of rescanning changes that, and sending a
technician to reprint a label first wastes bench time.

Making that work required a fact base that did not exist, so
commitment 1 also ships `controlled_substance_dispensing` (migration
`20260801030000_controlled_substance_dispensing`) — one append-only row
per order line that dispensed a controlled substance, written inside
the fill-completion transaction. Without it, "has this been refilled?"
and "how much of this fill is already supplied?" are unanswerable and
the refill caps and partial-fill windows cannot be enforced at all.
Three properties of that ledger are load-bearing:

- **`fillNumber` is a fill ordinal, not a row count.** Several rows
  share a `fillNumber` when one fill completes across multiple partial
  dispensings. This is precisely the distinction § 1306.12(a) turns on:
  a Schedule II prescription may not be REFILLED, but § 1306.13 permits
  supplying the remainder of one partially filled.
- **Unique on `orderLineId`.** If an order is reworked and
  `CompleteFill` runs again, the drug was still dispensed once; a
  second row would fabricate a refill that never happened. The
  evaluator also excludes the line's own row when reading history, so a
  re-verification is not rejected as a refill.
- **Non-controlled fills write nothing.** A row's existence means a
  controlled substance left the building, which is what makes the
  ledger useful as a § 1304 artifact.

Wiring also exposed a bug in the pure rules that the isolated tests had
not: `quantityAuthorized` is a PER-FILL quantity, so summing dispensed
quantity across a prescription's lifetime flagged every legitimate
refill as exceeding it. `DispensingRequest` now carries `fillNumber`
and `quantityDispensedInFill` instead of lifetime counters, and the
regression is pinned by test.

Operators declare a partial-fill basis per line at the bench
(`/ops/fill/[orderId]`), and only the bases lawful for that schedule
are offered — § 1306.13's three for Schedule II, § 1306.23's one for
Schedules III–V — because each carries a different completion deadline
and offering the wrong one would record the wrong window. Supplying
less than the authorized quantity without a stated basis is refused
outright: the basis fixes the deadline, so it cannot be reconstructed
afterwards.

Still not wired at issuance: `validateControlledPrescriptionAuthorization`
has no caller, because no `CreatePrescription` command exists — today
prescriptions are created only by `scripts/seed-demo-orders.ts`. An
over-authorized prescription is therefore still detectable only at
dispensing time, one fill too late.

### 2. Pharmax is declared as both application roles, and the internal handoff is an explicit design position

We meet §§ 1311.100–1311.170 as an electronic prescription application
and §§ 1311.200–1311.215 as a pharmacy application. Because the
prescriber and the pharmacy are the same deployment, there is no
network transmission between them; the § 1311.170 handoff is an
internal state transition. We archive per § 1311.210(a)(2) — the first
pharmacy application that receives the prescription digitally signs it
immediately on receipt — and we treat § 1311.170(e)'s no-alteration
rule as satisfied by construction because no serialization boundary is
crossed. **This position must be put to the third-party auditor before
build, not after.** It is the single largest certification risk in the
plan.

### 3. Credential issuance is a port; we integrate a CSP or CA, we do not become one

An `EpcsCredentialProvider` port in the engine configuration, mirroring
the `WebAuthnAdapter` and `PasswordHasher` ports. It exposes proofing-
status lookup, credential binding, and credential-validity checks
(including CRL consultation where the provider is a CA). The concrete
adapter — IdenTrust or another Federal Bridge cross-certified CA, or a
GSA-approved LoA-3 CSP — is chosen per deployment and injected at boot.
**The current GSA-approved CSP list and Federal Bridge cross-certified
CA list must be verified with GSA and DEA before an adapter is
selected**; we do not hard-code a vendor into the domain.

Pharmax stores the _provenance_ of issuance, never the credential
secret: CSP/CA identifier, proofing assurance level, proofing date,
the two-channel issuance attestation required by § 1311.105(c),
credential serial or AAGUID, and the FIPS validation certificate
number of the token.

### 4. The signing ceremony uses an application key, not the practitioner's private key

We implement § 1311.120(b)(15): on completion of the practitioner's
two-factor protocol, _the application_ digitally signs the Part 1306
data elements and archives the signed record. We do **not** implement
§ 1311.145 (practitioner signs with their own private key) in v1.

The signing key is an AWS KMS asymmetric key, reusing the ADR-0023 KMS
adapter and the ADR-0028 inventory and rotation policy. KMS satisfies
§ 1311.120(b)(16): FIPS 140-2 Level 1 or higher validated module,
FIPS 186-3 signature algorithm, FIPS 180-3 hash, and a private key that
never leaves the module — which also makes (b)(16)(iv), clearing
plaintext key material from application memory, vacuous by
construction.

### 5. The `have` factor must be a roaming hard token, which tightens the ADR-0036 ceremony

§ 1311.115(a) requires two of three factors and § 1311.115(b) requires
that a hard token be "separate from the computer to which it is gaining
access" and meet at least FIPS 140-2 Security Level 1. Our factors are
password (`know`) plus hard token (`have`); biometrics are out of scope,
avoiding the § 1311.116 subsystem-testing burden entirely.

The ADR-0036 WebAuthn adapter is reusable as a _mechanism_, but its
current ceremony policy is non-compliant for this purpose and must be
overridden in the EPCS path:

| Setting                   | ADR-0036 operator sign-in | EPCS signing                                                            |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `authenticatorAttachment` | unset (platform allowed)  | `cross-platform` — a platform passkey is not separate from the computer |
| `attestationType`         | `none`                    | `direct` — AAGUID must be checkable                                     |
| AAGUID handling           | stored for forensics      | verified against a FIPS-validated model allowlist                       |

Attestation moves from `none` to `direct` because we must prove the
authenticator _model_, which is the only way to establish FIPS 140-2
Level 1 conformance. This is a genuine behavioural divergence from
ADR-0036, not a configuration nicety.

### 6. EPCS credentials are a distinct entity, not `WebAuthnCredential` rows

`EpcsCredential` binds to `PortalAccount`, not to operator `User`, and
carries the § 1311.105 issuance provenance from commitment 3 that a
`WebAuthnCredential` has no place to hold. Reusing the existing table
would silently conflate a self-enrolled convenience passkey with a
CSP-issued, identity-proofed signing credential — a distinction the
regulation turns on entirely.

### 7. Two-person logical access control is its own model, with its own two-phase commit

Two new entities:

- `EpcsDesignatedIndividual` — per registered location, satisfying
  § 1311.125(a)'s "at least two, at least one a registrant authorized
  to prescribe who holds a two-factor credential."
- `EpcsAccessControlGrant` — a two-phase record. Individual A creates it
  in `ENTERED`. Individual B, who must be a distinct designated
  individual, must be a DEA registrant, and must complete two-factor
  authentication per § 1311.120(b)(5), moves it to `EXECUTED`. Only an
  `EXECUTED` grant confers signing authority.

Revocation per § 1311.125(d) is automatic and same-day on: lost, stolen,
or compromised token; DEA registration expiry, termination, revocation,
or suspension; or loss of authorization to use the application. This is
where the existing `DEA_SURRENDERED_OR_REVOKED` and `SANCTIONED`
provider-deactivation reason codes finally acquire a consumer — the
`provider.deactivated.v1` subscriber that ADR's comment anticipated but
never got.

### 8. The signed record is immutable, separately keyed, and retention-held

`EpcsSignedPrescription` stores the canonical serialized § 1306.05(a)
payload, its hash, the KMS signature and key id, the signing timestamp,
and a reference to the two-factor authentication event that constituted
the signature. It is append-only: no update path, and any attempt to
alter the underlying Part 1306 data cancels the prescription per
§ 1311.120(b)(19) rather than mutating it.

Because the payload is PHI, it is encrypted — but under a **dedicated
DEK with its own retention lifecycle**, deliberately not the patient
DEK. `planCryptoShred` becomes retention-aware and must refuse (not
silently skip) a shred that would destroy a CS record inside its
retention window; `CryptoShredPatient` surfaces this as a typed
`PATIENT_SHRED_BLOCKED_BY_CS_RETENTION` rejection listing the blocking
records and the date the hold lifts. Retention is the longer of the
federal two years (§ 1311.305(b)) and any applicable state rule.

### 9. Auditable events extend the existing digest seam; DEA notification is a runbook

§ 1311.150 (prescribing side) and § 1311.215 (pharmacy side) both require
a defined auditable-event list, **daily** audit-trail analysis, and an
incident report. The existing nightly security digest
(`compose-nightly-security-digest.ts`, `nightly-security-digest-loop.ts`)
is the right seam and already runs on the right cadence. We add an EPCS
event class and a distinct EPCS incident report.

The one-business-day DEA notification duty (§ 1311.150(c), § 1311.215(c))
is a documented runbook obligation with a named owner, not an automated
send. The audit records themselves must be protected from deletion and
modification (§ 1311.120(b)(26), § 1311.205(b)(16)) — satisfied by the
ADR-0006 hash-chained audit log plus the RLS policy-level immutability
already applied to `audit_log`.

### 10. The audited surface is bounded, versioned, and release-gated

All CS-prescription functionality lives in `@pharmax/epcs` behind a
narrow, explicitly versioned public surface. Changes to that surface
are a release gate requiring re-audit before production use, tracked in
CODEOWNERS and enforced in CI. This is a direct response to
§ 1311.300(a)(2): the smaller and more stable the audited module, the
less often a routine change drags the whole CS surface back through
certification.

## Consequences

**Easier:**

- Controlled-substance schedule awareness (commitment 1) unblocks Part
  1306 dispensing rules, § 1304 recordkeeping, PDMP reporting, and CS
  inventory reconciliation independently of the EPCS work — real value
  even if EPCS is later deferred.
- The port-and-adapter shape keeps CSP/CA choice reversible and keeps
  the domain testable without a vendor sandbox or physical tokens,
  exactly as the ADR-0036 WebAuthn port does.
- Signing with a KMS application key sidesteps browser PKI entirely.
  No PKCS#11 middleware, no native helper app, no smart-card driver
  support matrix.
- The two-person grant model gives the SoD posture from ADR-0030 a
  concrete, auditable expression that generalizes beyond EPCS.

**Harder / obligations:**

- **Production use is gated on third-party certification.** Nothing
  here can be shipped incrementally to production. The audited surface
  must be complete and certified before the first production CS
  prescription, which inverts the repo's usual thin-slice cadence: we
  can build and merge in slices, but we cannot _enable_ in slices.
- **Every change to CS functionality triggers re-audit** (§ 1311.300(a)(2)),
  and a two-year clock runs regardless. Ongoing cost, forever.
- **NIST time synchronization within five minutes** is now a compliance
  control (§ 1311.120(b)(8), § 1311.205(b)(4)(v)), requiring a monitored
  clock-drift probe with alerting, not just correct NTP configuration.
- **Daily backup of CS prescription records** (§ 1311.205(b)(17)) as a
  distinct, evidenced control separate from ordinary database backup.
- **Monthly per-practitioner prescription logs** delivered within seven
  calendar days of month end, on-demand logs spanning two years, all
  archived and sortable by patient, drug, and issuance date
  (§ 1311.120(b)(27)) — a new worker and a new report surface.
- **`PortalAccount` must gain a full MFA stack** it does not have today,
  and the portal must gain a prescription composition UI that satisfies
  § 1311.120(b)(9)'s mandatory review display and § 1311.140(a)(3)'s
  verbatim legal attestation text.
- **The crypto-shred contract changes.** A previously unconditional
  right-to-be-forgotten operation becomes conditionally refusable. This
  is a user-visible policy change with privacy-notice implications and
  needs Compliance sign-off independent of the engineering work.

**Failure modes:**

- _Auditor rejects the single-application configuration_ (commitment 2).
  Detected only by asking early; mitigated by treating auditor
  engagement as slice 0 rather than a final step.
- _Selected CSP loses GSA approval or the CA loses Federal Bridge
  cross-certification._ Detected by a periodic compliance check;
  contained by the adapter port, which makes provider substitution a
  configuration change rather than a rewrite.
- _A non-FIPS authenticator is enrolled_ because attestation was
  misconfigured or the AAGUID allowlist went stale. Detected by an
  enrollment-time allowlist check plus a periodic re-verification sweep
  over enrolled credentials.
- _Crypto-shred silently skips a held record_ instead of refusing,
  producing a false "forgotten" claim. Prevented by making the refusal
  a typed error with no silent-skip branch, and covered by a test that
  asserts the rejection.
- _CS functionality is altered without triggering re-audit._ Prevented
  by the module boundary, CODEOWNERS, and a CI gate on the
  `@pharmax/epcs` public surface.

## Alternatives Considered

- **Pharmacy-application scope only (§§ 1311.200–1311.215), receiving CS
  prescriptions from an external e-prescribing network.** Attractive
  because it is a fraction of the work: no identity proofing, no CSP
  integration, no signing ceremony, no two-person access control, no
  practitioner logs — and it still lets the pharmacy dispense
  electronically prescribed controlled substances, which is the actual
  business outcome most pharmacies need. Rejected only because the
  stated roadmap goal is prescriber-side signing in the Pharmax portal.
  **If that goal is negotiable, this is the better decision**, and it
  remains the recommended fallback. It would still require third-party
  certification, but of a much smaller surface.
- **Practitioner signs with their own private key (§ 1311.145).** Attractive
  because § 1311.145(g) relieves the application of applying its own
  signature and § 1311.210(c) lets the pharmacy archive the
  practitioner-signed record directly after verifying it and checking
  the CRL — arguably a stronger non-repudiation story, and the natural
  fit for an IdenTrust-issued certificate on a hard token. Rejected for
  v1 because invoking a smart-card private key from a browser requires
  PKCS#11 middleware or a native helper application; browser plugin
  APIs that once made this feasible are gone. Deferred, not foreclosed:
  the port in commitment 3 is shaped to accommodate it later.
- **Extending `@pharmax/rbac` to carry signing authority.** Attractive
  for consistency with every other permission in the system. Rejected
  because RBAC cannot express the two-person commit of § 1311.120(b)(4),
  the "second individual must be a DEA registrant" constraint of
  § 1311.125(c), or the same-day automatic revocation triggers of
  § 1311.125(d) — and bending RBAC to fit would compromise a
  general-purpose authorization system for one regulated edge case.
- **Reusing `WebAuthnCredential` for EPCS tokens.** Attractive because
  the table, adapter, and ceremony already exist. Rejected because the
  row has nowhere to record CSP issuance provenance, proofing assurance
  level, or FIPS validation, and conflating self-enrolled passkeys with
  identity-proofed signing credentials is precisely the distinction the
  regulation rests on.
- **Signing PHI payloads under the existing patient DEK.** Attractive
  for uniformity with the established envelope pattern. Rejected
  because a patient crypto-shred would destroy a record the DEA
  requires us to retain and produce on request.

## References

- Code (existing seams): `packages/auth/src/mfa/webauthn.ts` (adapter port
  to be reused with tightened policy), `packages/auth/src/configure.ts`
  (port injection pattern), `packages/providers/src/portal/sign-in-command.ts`
  (`PortalSignIn`, currently MFA-free),
  `packages/providers/src/onboarding/proofing.ts` (NPPES matching — _not_
  identity proofing), `packages/crypto/src/shred.ts` (`planCryptoShred`,
  to become retention-aware),
  `packages/security/src/security-digest/compose-nightly-security-digest.ts`
  (daily audit-analysis seam).
- Code (new): `packages/epcs/` — the audited module boundary.
- Schema: `prisma/schema.prisma` — `ControlledSubstanceSchedule` on
  `Product` / `Prescription`; new `EpcsCredential`,
  `EpcsDesignatedIndividual`, `EpcsAccessControlGrant`,
  `EpcsSignedPrescription`.
- Companion ADRs: `0006` (hash-chained audit log — satisfies the
  audit-record immutability requirement), `0023` (KMS adapter),
  `0028` (KMS inventory and rotation), `0030` (in-house identity
  engine), `0033` (provider portal — explicitly scoped EPCS out; this
  ADR reverses that scoping), `0035` (compounding domain), `0036`
  (WebAuthn — mechanism reused, ceremony policy diverges).
- External (verified against eCFR, title 21 issue date 2026-07-30):
  21 CFR §§ 1311.100–1311.170 (electronic prescription application),
  §§ 1311.200–1311.215 (pharmacy application),
  §§ 1311.300–1311.305 (third-party audit, recordkeeping),
  21 CFR part 1306 (prescription requirements),
  21 CFR § 1301.22(c) (institutional practitioner internal codes),
  NIST SP 800-63-1 (assurance levels as incorporated by § 1311.08),
  FIPS 140-2, FIPS 186-3, FIPS 180-3.
- Public sources: `docs/governance/public-sources-reference.md` (Part 1311
  row) — the `ControlledSubstanceSchedule` state machine named in the
  Part 1306 row is delivered by commitment 1 of this ADR.
- Implementation plan: `docs/IMPLEMENTATION_PLAN.md`.
