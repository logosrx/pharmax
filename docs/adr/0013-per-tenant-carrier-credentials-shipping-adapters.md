# 0013 — Per-tenant carrier credentials encrypted via `@pharmax/crypto`; multi-carrier via `ShippingAdapter` port + factory registry

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** shipping, security, integrations

## Context

Pharmax ships from multiple pharmacy sites, and each tenant has its
own commercial relationship with one or more carriers (EasyPost as a
broker, FedEx direct, UPS direct, future DHL). A single shared "ops
API key per carrier" approach is wrong: billing (each tenant pays its
own carrier), isolation (a leaked shared key exposes every tenant),
and vendor heterogeneity (EasyPost is one key; FedEx and UPS are
OAuth2 client_credentials with separate `<key>:<secret>` halves;
UPS additionally pins a shipper-number header).

We need a credential model that supports per-tenant rotation, a
shipping interface that works the same regardless of carrier, and
an admin path that lets operators register keys without those keys
ever appearing in logs.

## Decision

Two parts: an **encrypted per-tenant credential row** and a **port +
factory-registry pattern** for adapters.

**Credential storage (`carrier_credential` table):**

- Migration `20260601000000_phase4_carrier_credential` adds the table.
  Columns include `apiKeyEnc` and `webhookSecretEnc` (Json envelopes
  encrypted via ADR 0005 with AAD bound to
  `{tenantId, "carrier_credential", "apiKey"|"webhookSecret", id}`).
- Enums `ShippingProvider` (`EASYPOST` / `FEDEX` / `UPS`) and
  `CarrierCredentialStatus` (`ACTIVE` / `DISABLED`). A
  **partial-unique-active index** allows one ACTIVE row per
  `(organizationId, provider)` while preserving history (rotated keys
  become `DISABLED` rows, never deleted).
- Tenant-scoped under the standard RLS regime (ADR 0004).
- **`RegisterCarrierCredential`** is the only supported write path;
  it encrypts via `@pharmax/crypto`, replaces any prior ACTIVE row by
  transitioning it to DISABLED in the same tx, and lists `apiKey` and
  `webhookSecret` in the bus's `redactFields`.

**Multi-carrier abstraction (`ShippingAdapter` port):**

- `@pharmax/shipping` defines `ShippingAdapter` (`purchase`,
  `cancelLabel`, `track`, ...) returning a stable `PurchasedLabel`
  shape (with `labelPdfBase64 | null` so the printer path needs no
  second HTTP fetch).
- `configureShipping({ factories: { EASYPOST?, FEDEX?, UPS? } })` is
  a boot-time **factory registry**. Each factory receives a per-org
  `CarrierCredentialContext` with the **decrypted** API key, webhook
  secret, carrier-account id, and optional base-URL override.
- `resolveShippingAdapter(provider, organizationId)` decrypts the
  active credential, invokes the factory, and returns the adapter.
  Hot-path commands stamp the resolved `provider` + `credentialId`
  on audit + outbox for forensic tie-back.

## Consequences

**Easier:**

- Onboarding a new tenant's carrier is a single admin write through
  the standard bus, with full audit trail and key redaction.
- Rotating a key is a re-run of `RegisterCarrierCredential`; the
  prior row becomes `DISABLED` and stays for history.
- Adding a new carrier (e.g. DHL) is one new factory + one enum
  value + one adapter implementation; consumers see the same
  `ShippingAdapter` interface.
- A leaked credential affects exactly one tenant.

**Harder:**

- The factory registry is **boot-time only**. Production binds real
  factories; tests bind deterministic stubs. Forgetting to wire a
  factory surfaces as a typed `NO_ACTIVE_CARRIER_CREDENTIAL` or
  `SHIPPING_FACTORY_NOT_REGISTERED` at first dispatch.
- The `ShippingAdapter` interface is a contract. Adding a method
  that one carrier supports but another does not requires either
  per-carrier negotiation in the interface or an `optional` marker
  with explicit "this carrier doesn't support cancel" handling at
  the call site (currently the latter, e.g. `cancelLabel?:`).
- Decryption happens on every shipping dispatch; we accept the cost
  and pin per-org credential lookups via the
  `(organizationId, provider)` index.

**Ongoing obligations:**

- New carriers go through the same port and the same encrypted
  credential path. Direct SDK access from inside the shipping
  package (skipping the factory registry) is a review red flag.
- Webhook secrets are stored encrypted and resolved per-tenant for
  the verifier path (`verifyEasyPostSignature`, etc.).

## Alternatives Considered

- **Single shared carrier account.** Wrong billing model, wrong
  isolation model. Non-starter.
- **Credential storage in environment variables per tenant.** Does
  not scale to multi-tenant SaaS; rotation is an ops ticket, not an
  admin action.
- **One omnibus shipping client (e.g. EasyPost only).** Locks the
  product to one broker; loses the direct-carrier rate advantage
  that tenants with large carrier discounts depend on.

## References

- ADR 0005 — Envelope encryption per PHI field (same primitive)
- `prisma/migrations/20260601000000_phase4_carrier_credential/`
- `packages/shipping/src/` — `ShippingAdapter`, `configure.ts`,
  `resolve-adapter.ts`, `carriers/easypost-factory.ts`, FedEx + UPS factories
- `packages/shipping/src/commands/register-carrier-credential.ts`
- `apps/web/app/api/ops/admin/carriers/register/route.ts` — admin UI dispatch
