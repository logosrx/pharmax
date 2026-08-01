# 0032 — Partner API keys and outbound webhooks (public v1 platform surface)

- **Status:** Accepted
- **Date:** 2026-07-24
- **Deciders:** Platform team
- **Tags:** `api`, `webhooks`, `security`, `platform`

## Context

ADR-0031 made the public v1 API plus outbound partner webhooks the
next platform milestone (P0). This ADR records the concrete design
for both halves: how a partner authenticates against `/api/v1/*`, and
how domain events leave the platform toward partner endpoints.

Constraints inherited from the existing architecture:

- Every tenant-scoped table gets RLS + tenancy-registry
  classification (ADR-0004).
- Every credential at rest is hashed or envelope-encrypted
  (`@pharmax/crypto`, ADR pattern from `carrier_credential`).
- Every critical mutation goes through the command bus with
  idempotency, command_log, audit_log, and event_outbox (ADR-0007).
- Outbound side effects ride the outbox → worker drain pattern
  (ADR-0009); payloads must be registry-validated (ADR-0018).

## Decision

### Partner API keys

- New `api_key` table: org-scoped, RLS-protected. The row stores a
  SHA-256 **hash** of the opaque bearer token (`pxk_<256-bit
base64url>`), a display prefix, and a `scopes` array of existing
  RBAC permission codes. The raw token exists only in the HTTP
  response of the mint call — never at rest, never in
  `command_log`/`idempotency_key` (the token is generated at the
  transport layer; the command receives only the hash).
- Resolution mirrors `AuthSession`: unique indexed lookup by
  `tokenHash` in a system-context frame, after which all reads and
  dispatches run inside the resolved org's tenancy.
- **Actor semantics:** a key acts on behalf of the operator who
  minted it (`createdByUserId`). Reads are gated by key scopes;
  mutations are additionally gated by the acting user's live RBAC at
  dispatch time, so revoking the operator revokes the key's mutation
  authority with it.
- Minting/revoking are commands (`CreateApiKey`, `RevokeApiKey`)
  behind a new `api.keys.manage` permission. Minting also requires a
  caller-supplied `Idempotency-Key` header (namespaced per operator)
  — the retry boundary is owned by the CALLER, never derived from
  server-generated material.
- v1 mutations require a caller-supplied `Idempotency-Key` header,
  mapped onto the existing `IdempotencyKey` model via the bus.

### Idempotent replay of one-time secrets

Because the raw secret (API-key token, webhook signing secret) is
generated at the transport layer and regenerated on every HTTP
attempt, two bus-level accommodations exist:

- The commands declare `hashExcludeFields` for the per-attempt secret
  material, so a retried request hash-matches its first attempt and
  replays instead of being rejected as a payload mismatch. Client-
  controlled fields stay fully hashed — the mismatch guard is not
  weakened.
- Routes dispatch via `executeCommandDetailed` and branch on the
  `replayed` flag: a replay returns the ORIGINAL resource as a 200
  with the secret field `null` and `meta.idempotentReplay: true`.
  The fresh secret generated on the retried attempt was never stored
  and is discarded — returning it would hand the caller a credential
  that verifies nothing. Recovery from a lost first response is
  revoke + recreate.

### Outbound webhooks

- New `webhook_subscription` table: org-scoped, RLS-protected;
  HTTPS-only URL, envelope-encrypted signing secret (`pxw_` prefix,
  returned once at creation), and an event-type filter restricted to
  **registry events with `phiSafe: true`**. Managed by
  `CreateWebhookSubscription` / `RevokeWebhookSubscription` behind a
  new `webhooks.manage` permission (exposed on v1 so partners can
  self-serve).
- Fan-out happens in the existing outbox drainer: eligible event
  types get a composed handler that, after any domain handler runs,
  validates the payload against the event registry and inserts one
  `webhook_delivery` row per matching ACTIVE subscription
  (idempotent on `(subscriptionId, outboxEventId)`). Payloads that
  fail registry validation are **not** delivered (logged, skipped) —
  the raw-outbox-literal gap stays closed at the egress boundary.
- A dedicated `webhook-delivery` drain claims PENDING/FAILED rows
  (`FOR UPDATE SKIP LOCKED` + lease, same as the outbox), POSTs the
  payload with a Stripe-style signature header
  (`Pharmax-Signature: t=<unix>,v1=<hex HMAC-SHA-256 of "<t>.<body>">`),
  and marks SENT / FAILED-with-backoff / DEAD. The ledger doubles as
  the partner-visible delivery history and dead-letter view.

### Explicitly out of scope for this slice

- v1 write endpoints for orders (reads only until the intake API is
  designed); per-key rate quotas beyond the shared limiter; the
  developer portal UI. Each lands as its own increment on this
  foundation.

> **Amendment (2026-07-31):** three of the deferred increments have
> landed on this foundation:
>
> - **Order intake** — `POST /api/v1/orders` dispatches the existing
>   `CreateOrder` command under the `orders.create` scope.
>   `intakeSourceKind` is forced to `API` at the transport (a client
>   claim of intake provenance is rejected, not coerced). All
>   workflow invariants stay in the command.
> - **Secret rotation** — `RotateWebhookSubscriptionSecret` re-keys a
>   subscription in place (`POST
/api/v1/webhook-subscriptions/{id}/rotate-secret`). Same
>   transport contract as creation: secret generated at the route,
>   redacted + hash-excluded through the bus, returned exactly once;
>   replays return `secret: null`. Single-secret cut-over — every
>   attempt after commit signs with the new secret. Only ACTIVE
>   subscriptions rotate (no silent re-arm of a revoked endpoint).
>   Announced as `platform.webhook_subscription.secret_rotated.v1`.
> - **Developer portal (operator side)** — `/ops/admin/api-keys`
>   (mint/revoke, fetch-based because of the one-time token) and
>   `/ops/admin/webhooks` (subscription list with per-status delivery
>   counts, delivery ledger/dead-letter view, MFA-gated revoke kill
>   switch). Partner-side subscription management remains on the v1
>   API itself.
>
> Still open: per-key rate quotas beyond the shared limiter; a
> partner-facing (not operator-facing) portal; dual-secret rotation
> overlap windows.

> **Amendment (2026-07-31, quota tiers):** per-key quotas landed as
> **named tiers**. The `api_key` row records WHICH tier a key belongs
> to (`quotaTier` enum, default `STANDARD`); the numbers behind each
> tier live in code (`@pharmax/partner-api` `API_KEY_QUOTA_TIERS`) so
> they can change without a migration. Each tier carries two
> independent ceilings, enforced as two limiter windows on the
> partner request path:
>
> - **burst** (per-minute) → `429 RATE_LIMITED` + `Retry-After` —
>   transient traffic shaping; STANDARD's 120/min is exactly the
>   pre-tier shared limit, so no existing partner's ceiling changed.
> - **daily quota** → `429 QUOTA_EXCEEDED` + `Retry-After` — the
>   integration is over its tier (STANDARD 50k/day, ELEVATED
>   250k/day); upgrade or wait for the reset. Requests rejected by
>   the burst gate do not consume daily quota, and unauthenticated
>   requests never touch the limiter (anonymous traffic cannot burn
>   a partner's quota).
>
> The tier is chosen at mint time (command input, ops-console
> selector), recorded in the audit trail and the
> `platform.api_key.created.v1` payload (optional field — events
> emitted before tiers existed mean STANDARD).
>
> Still open: a partner-facing portal; dual-secret rotation overlap
> windows; tier changes on a LIVE key (today the path is revoke +
> re-mint at the new tier — acceptable while tier changes are rare
> partner-agreement events, revisit if they become routine).

## Consequences

- Two new permissions (`api.keys.manage`, `webhooks.manage`) enter
  the registry, seed, and OrgAdmin template.
- Three new RLS-protected tables; the tenancy registry grows by
  three entries (SOC 2 audit event, justified here).
- The outbox drainer's handler map is now partially generated
  (fan-out composition) — the registry-contract test keeps
  REQUIRED_HANDLER_EVENT_TYPES semantics intact.
- Compromise blast radius of a leaked partner key is bounded by its
  scopes and its creator's RBAC; recovery is `RevokeApiKey` (audited).
- ~~HMAC secrets can be rotated only by revoke + recreate in this
  slice; in-place rotation is a follow-up.~~ Superseded 2026-07-31:
  in-place rotation landed (see amendment above).

## Alternatives Considered

- **Per-key service users** (like `WebhookService`): cleaner actor
  identity, but requires user provisioning per key and a machine-user
  lifecycle we don't need for read-mostly v1. Revisit when partners
  get write access to workflow commands.
- **Fan-out at command time** (write `webhook_delivery` inside the
  command transaction): couples every command to subscription state
  and bloats the hot transaction; rejected in favor of the existing
  at-least-once outbox consumer.
- **JWT-based partner auth**: heavier issuance/rotation story with no
  benefit at this scale; opaque hashed tokens match the session
  engine's proven pattern.

## References

- ADR-0031 (platform reference architecture, P0 milestone)
- ADR-0004 (RLS tenancy), ADR-0007 (command bus), ADR-0009 (outbox),
  ADR-0018 (event schema registry), ADR-0030 (in-house identity)
- `docs/IMPLEMENTATION_PLAN.md` Phase 7
- OpenAPI contract: `docs/api/openapi-v1.yaml`
