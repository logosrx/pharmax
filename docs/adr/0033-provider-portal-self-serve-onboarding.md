# 0033 — Provider portal and self-serve prescriber onboarding

- **Status:** Accepted
- **Date:** 2026-07-31
- **Deciders:** Platform team
- **Tags:** `providers`, `onboarding`, `identity`, `workflow`, `portal`

## Context

ADR-0031 named the provider portal with self-serve onboarding the
first P1 milestone ("orders now; provider onboarding next" for the
workflow engine, and "provider portal with self-serve onboarding"
first in the portal order). Today a prescriber only enters the
system when an operator runs `RegisterProvider` by hand — there is
no way for a clinic's prescriber to apply, be identity-checked, and
appear in the roster without staff in the loop.

Constraints inherited from the existing architecture:

- **Operators-only identity engine.** ADR-0030 scoped `@pharmax/auth`
  v1 to operators. `AuthSession` resolves to `User`, `User` has no
  principal-kind discriminator, and `/sign-up` is intentionally
  closed. External humans must NOT become `User` rows.
- **Workflow engine.** The `workflow_policy` table is generic
  (`code`, `version`, `definition Json`) and the command-bus
  `defineCommand({ loadPolicy })` facility resolves and pins a
  policy row per dispatch, but every concrete policy today is
  order-shaped (`order.standard` v1).
- **Machine actors.** Worker- and portal-initiated dispatches
  already have a precedent: per-org service users with narrow
  machine roles (`WebhookService`, `NpiSyncWorker`) act as the
  command actor inside the org's tenancy frame.
- **Public identity source.** `CmsNppesClient`
  (`packages/providers/src/npi-sync/cms-client.ts`) already wraps
  the public CMS NPPES registry with typed errors, rate limiting,
  and a normalized `CmsNpiSnapshot` (name, credential, status,
  enumeration type). It is the authoritative record we match
  applicants against. NPPES is a public data set — clean-room safe
  and PHI-free.

## Decision

### 1. Onboarding is a workflow-governed application aggregate

New org-scoped, RLS-protected table `provider_onboarding_application`:

- Identity claim: `npi`, `firstName`, `lastName`, optional
  `credential`, contact `email`/`phone` (prescriber office contact —
  public professional data, not PHI).
- Status machine (enum `ProviderOnboardingStatus`):

  ```
  SUBMITTED → APPROVED            (proofing PASS — no staff in loop)
  SUBMITTED → NEEDS_REVIEW        (proofing mismatch / not found / deactivated NPI)
  NEEDS_REVIEW → APPROVED         (ops reviewer, reason code)
  NEEDS_REVIEW → REJECTED         (ops reviewer, reason code)
  ```

- Every row pins `workflowPolicyId` + `workflowPolicyVersion` from a
  new seeded `provider.onboarding` v1 `workflow_policy` row, loaded
  through the same `defineCommand({ loadPolicy })` machinery orders
  use. This is the first non-order policy, exactly where ADR-0031
  said the engine goes next.
- Proofing evidence is stored on the row (`proofingOutcome`,
  `proofingSnapshot Json`, `proofedAt`): the NPPES snapshot that
  drove the decision, so reviewers and auditors see WHY an
  application auto-approved or was routed to review. NPPES data is
  public; the snapshot is PHI-free by construction.
- Terminal decisions store `decidedByUserId`, `decidedAt`,
  `decisionReasonCode`; approval also stores the created
  `providerId`.
- Uniqueness: one **open** (SUBMITTED / NEEDS_REVIEW) application
  per `(organizationId, npi)` via a partial unique index — a
  rejected applicant may reapply; a duplicate open application is a 409.

### 2. Identity proofing = NPPES match, automated

A worker drain claims SUBMITTED applications, calls
`CmsNppesClient.fetchByNpi`, and dispatches
`RecordProviderOnboardingProofing` as the org's machine user:

- **PASS** requires: NPI found, individual (NPI-1), CMS status
  active, and a normalized last-name match between the claim and
  the registry record. PASS transitions straight to APPROVED and
  creates the `Provider` row in the same transaction (same insert +
  `provider.registered.v1` emission semantics as `RegisterProvider`,
  including the `(organizationId, npi)` conflict guard).
- Anything else (not found, org-type NPI, deactivated, name
  mismatch, registry outage after retries) routes to NEEDS_REVIEW
  with a typed mismatch code — a human decides; the system never
  hard-rejects on registry data alone.
- This is professional-identifier verification, not IAL2 identity
  proofing. It answers "is this a real, active prescriber whose
  registry record matches the claim", which is the roster-integrity
  bar. EPCS-grade proofing is explicitly out of scope.

### 3. Application intake is public, rate-limited, machine-actor

`POST /api/portal/v1/onboarding/applications` is the first portal
API endpoint (versioned, contract-tested — the amendment-7 bar
applies to the portal surface from day one):

- Unauthenticated by necessity (the applicant has no credential
  yet), therefore strictly rate-limited per IP and per
  `(org, npi)`, body-validated with Zod, and `Idempotency-Key`
  required like every other public write.
- The target org is resolved from an org-scoped onboarding slug in
  the path/body (system-context lookup, mirroring how the partner
  API resolves a key before entering the tenancy frame). Orgs
  opt in; there is no cross-org discovery endpoint.
- The command actor is a per-org `ProviderOnboardingService` machine
  user with a narrow machine role (submit + proofing permissions
  only), following the `NpiSyncWorker` precedent. Ops decisions
  (approve/reject from review) use the human reviewer as actor with
  a new `providers.onboarding.review` permission.

### 4. Portal principals are a separate model — deferred to slice 2

Provider portal sign-in will use a new `PortalAccount` +
`PortalSession` pair (argon2id + opaque tokens, reusing
`@pharmax/auth` primitives) that resolves to a `Provider`, never to
a `User`. A portal credential structurally cannot mint an operator
session. On approval, slice 2 issues a one-time portal setup token
to the application email (accept-invite pattern). Slice 1 captures
the email on the application; no portal credential exists yet.

### Slicing

1. **(this ADR's slice — shipped 2026-07-31)** Application aggregate +
   `provider.onboarding` v1 policy + submit/proofing/approve/reject
   commands + NPPES proofing drain + public apply endpoint + ops
   review queue + events + tests.
2. **(shipped 2026-07-31)** Portal accounts + sessions + sign-in +
   application-status page; approval-time setup-token issuance.
   Landed as designed: `PortalAccount`/`PortalSession`/
   `PortalSetupToken` (RLS'd, tokens hashed at rest, operator
   `SessionPolicy` reused), `packages/providers/src/portal/` commands
   on `@pharmax/auth` primitives, provisioning atomic with BOTH
   approval paths (email conflict skips provisioning, never fails
   the approval), setup-link email post-commit, distinct
   `pharmax_portal_session` cookie + `/portal` pages + versioned
   `/api/portal/v1/auth/*` routes. Portal sign-in shares the
   `login_attempt` lockout ledger under separate `portal-signin:*`
   burst keys. No MFA in v1 (read-only-own-data capability; revisit
   with slice 3 write features).
3. **(shipped 2026-07-31)** Portal features. Landed as designed:
   - Prescriber order visibility: `/portal/orders` backed by a
     system-context read helper scoped to `(organizationId,
providerId)`; the projection is PHI-free (rx numbers, drug
     name/strength, order status/dates — no patient identifiers).
   - Profile updates routed through `UpdateProvider` with a
     dedicated `ProviderPortalService` machine actor (contact
     fields only; the portal account id is embedded in the
     idempotency key for audit attribution).
   - Shipped-order email notification: an outbox handler composed
     with the billing materializer on `order.shipped.v1` emails
     each prescriber with an ACTIVE portal account their own rx
     numbers (per-recipient idempotency keys; recipient failure
     throws for drainer retry).
   - `ChangePortalPassword`: current-password check, policy +
     breach + reuse checks against the new `portal_password_history`
     table (RLS'd), other-session revocation, and
     `provider.portal_account.password_changed.v1`.
   - **MFA revisit (decision):** still deferred. The write surface
     added here is narrow and low-blast-radius — own contact fields
     and own password, both rate-limited, audited, and routed
     through commands. MFA (reusing the operator TOTP stack)
     becomes a blocker the moment the portal gains clinically
     significant writes — prescription submission, order actions,
     or patient-data access. That feature, not time, is the
     trigger.

## Consequences

- The workflow engine gains its second policy family without a
  TypeScript generalization of `OrderWorkflowPolicy` — the
  onboarding commands validate their own (much smaller) transition
  table against the pinned policy definition. If a third non-order
  workflow appears, THAT is the trigger to extract a shared
  transition-validation core.
- A new public, unauthenticated write endpoint is attack surface.
  Mitigations: per-IP and per-(org, npi) rate limits, the open-
  application partial unique index (one pending application per
  prescriber per org), no enumeration responses (submission returns
  the application id and status only), and the machine actor's
  least-privilege role. CAPTCHA is deliberately deferred until abuse
  is observed.
- Auto-approval creates `Provider` rows without human review when
  NPPES matches. The roster-integrity risk is bounded: the NPI must
  exist, be active, be an individual, and name-match; and the same
  NPI-sync reconciliation that governs manually-registered providers
  governs these rows afterward. Orgs that want human review for
  every application can get a policy-overlay knob later (the
  decision is policy-pinned, so the hook exists).
- Rejected applications keep their proofing snapshots for the audit
  trail (7y retention class, same as provider events).

## Alternatives considered

- **Providers as `User` rows with a `kind` column.** Rejected:
  ADR-0030 scoped the identity engine to operators on purpose;
  `User` drags ~35 operator-action relations and operator RBAC
  semantics with it. A separate principal model keeps the blast
  radius of a portal-credential compromise structurally outside the
  ops console.
- **Ops-invite-only onboarding (no public endpoint).** Rejected as
  the end state — it fails the "self-serve, no staff in the loop"
  product requirement — but the ops review queue keeps the
  human path for every non-clean case.
- **Generalize the workflow engine's TypeScript first.** Rejected
  for this slice: the onboarding state machine is 4 states / 4
  transitions; buying a generic engine now is speculative. The
  policy PINNING (the auditable part) already generalizes via
  `loadPolicy`.
- **Third-party identity-proofing vendor (IAL2).** Deferred: NPPES
  matching meets the roster-integrity bar for a v1 portal whose only
  post-approval capability is read access to the prescriber's own
  data. Revisit when the portal gains order-creation rights.
