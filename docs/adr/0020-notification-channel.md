# 0020 — Notification channel port + typed template registry

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Platform team
- **Tags:** `architecture`, `security`, `notifications`

## Context

The platform predictably needs to deliver human-targeted messages from many
domain packages: billing emits an "invoice payment failed" alert when Stripe
reports a failed charge; orders emits a "hold has exceeded its expected
window" reminder; shipping emits a "shipment escalated to the emergency
bucket" notice. There is no abstraction for "send a message" today.

Every domain package that needs to alert a human currently has to either
(a) reach for a transport SDK directly (Resend, Twilio) or (b) drop a
custom payload on the event outbox and hope a future worker drain interprets
it correctly. Both paths reinvent the same shape — recipient, template,
context payload, idempotency key — and both blur the line between "this
event happened" and "this is the message that gets sent". A worse failure
mode lurks behind path (a): the moment a domain package imports a vendor
SDK, every test in that package inherits the vendor's network dependency
and credentials, and HIPAA-aware transports leak into non-HIPAA contexts.

PHI safety adds a second axis. The platform's threat model classifies
patient identifiers — names, dates of birth, MRNs, SSN fragments, contact
fields — as PHI that must NOT appear in routine notification payloads. A
template that says "Hi {firstName}, your order shipped" is a HIPAA event
unless the transport is HIPAA-eligible (BAA in place, SSE-KMS at rest,
no third-party log retention). Today nothing prevents a careless caller
from passing a patient record verbatim into a marketing-email send.

We need a single cross-cutting layer that domain packages depend on
(through a port, not an SDK), that production composes against real
transports, and whose PHI safety is structural — caught at the channel
boundary instead of relying on every caller getting it right.

## Decision

Introduce `@pharmax/notifications` as a new workspace package with **three**
day-one pieces:

1. **`NotificationChannel` port** with a single `send(input)` method.
   `input` carries `to: NotificationRecipient`, `template:
NotificationTemplateId`, `context: Record<string, unknown>`,
   `idempotencyKey: string`, and an optional `correlationId`. The
   channel publishes a `metadata` descriptor that reports its name,
   the recipient kinds it supports, and whether it is HIPAA-eligible
   (`phiCapable: boolean`).

2. **Typed template registry** in
   `templates/template-registry.ts` keyed by a frozen
   `NotificationTemplateId` union. Every template ships with the
   recipient kinds it supports, the required context keys it consumes,
   a `phiAllowed: boolean` flag (default `false`), and a short
   description. Day-one entries mirror the existing event vocabulary:
   `INVOICE_PAYMENT_FAILED_V1`, `INVOICE_FINALIZED_V1`,
   `INVOICE_REFUND_ISSUED_V1`, `INVOICE_UNCOLLECTIBLE_V1`,
   `ORDER_HOLD_EXPIRY_REMINDER_V1`, `ORDER_PV1_REJECTED_V1`,
   `ORDER_FINAL_REJECTED_V1`, `SHIPMENT_ESCALATED_V1`,
   `SHIPMENT_ESCALATION_ACKNOWLEDGED_V1`, and
   `SHIPMENT_ESCALATION_RESOLVED_V1`.

3. **In-memory adapter** (`InMemoryNotificationChannel`) that
   records every send for test assertions, dedupes by
   `idempotencyKey`, and supports `failNext()` for failure-path
   tests. The boot-time `configureNotifications({ channel })`
   singleton mirrors `@pharmax/package-capture::configurePackagePhotoStorage`
   and `@pharmax/crypto::configureCrypto`; reading without
   configuration throws `InternalError(NOTIFICATIONS_NOT_CONFIGURED)`.

PHI safety is enforced **structurally** at the channel boundary by
`assertNoPhiInContext()`: top-level context keys are matched against a
sentinel list (`firstName`, `lastName`, `dateOfBirth`, `mrn`, exact
matches; `dob*`, `ssn*`, `phone*`, `email*` prefixes). A send that
trips a sentinel is rejected with `AuthorizationError(NOTIFICATION_PHI_REJECTED)`
UNLESS the template is flagged `phiAllowed: true` AND the channel is
flagged `phiCapable: true`. Both gates must open; flipping just one is
not enough. The error envelope reports the offending KEY name only —
never the value — so the PHI never leaks into logs.

## Consequences

**Becomes easier.**

- Every future notification (alpha test reminders, payment receipts,
  password resets, MFA challenges) lands as a new registry entry + a
  caller site that imports `getNotificationChannel()`. No vendor SDK
  in the domain package.
- Tests run against the in-memory adapter with no network, no credentials,
  and no vendor mocks. The recorded-send array makes "did we send
  exactly one INVOICE_PAYMENT_FAILED_V1 to this clinic?" a one-line
  assertion.
- Swapping vendors (Resend → SendGrid, Twilio → Vonage) is one
  boot-time line. The domain packages don't know which vendor delivered.
- A reviewer can audit "what notifications can this platform send?" by
  reading one file (`template-registry.ts`).

**Becomes harder / ongoing obligations.**

- Adding a new template requires editing the registry — a small
  ceremony but not a typo-and-deploy. We accept this: typos in the
  template id become type errors, not silent send-to-nothings.
- A change to a template's `requiredContextKeys` or its rendered
  shape is a NEW template id (`_V2`). Old in-flight queued sends
  continue to render against the old shape. Mutating an existing
  template id in place is a breaking change.
- The PHI sentinel list is intentionally narrow. Deep DLP (regex over
  stringified leaves, SSN-shape detection) is NOT in scope; if we ever
  need it, it belongs in a downstream proxy. The current sentinel list
  catches the common-case "I forgot to scrub the patient record before
  handing it to the template" mistake.
- Every production adapter MUST declare `phiCapable` correctly. A
  transport configured `phiCapable: true` without a BAA in place is a
  security incident. We treat the flag as a security-review gate.

**Failure modes + detection.**

- A caller passes an unregistered template id → TypeScript compile
  error.
- A caller passes a recipient kind the channel cannot deliver to →
  `NOTIFICATION_RECIPIENT_KIND_UNSUPPORTED` at send time. Tests catch
  this; production paths log the structured error.
- A caller leaks PHI into context → `NOTIFICATION_PHI_REJECTED` at
  send time. Logged as a security event.
- A transport fails downstream → `NOTIFICATION_TRANSPORT_ERROR` from
  the adapter. The retry policy lives in the worker drain that fires
  the send, not in this layer.

## Alternatives Considered

- **Per-integration libraries (one client per vendor in each
  domain package).** Rejected: every domain that wants to alert a
  human inherits a vendor SDK, vendor credentials, vendor test
  doubles, and vendor failure semantics. A platform with N domains
  and M vendors ends up with N×M client wrappers. PHI safety becomes
  a per-call discipline rather than a structural property.

- **Use the event outbox directly as the notification queue.** Rejected:
  the outbox is the right primitive for "this event happened"; it is
  the wrong primitive for "this is the human-targeted message". Consumers
  shouldn't have to know about transports to consume an event, and the
  template / recipient resolution belongs above the outbox. We compose
  the two: a worker drain on the outbox decides which event triggers
  which template, and calls `getNotificationChannel().send(...)`.

## Follow-ups

- Production adapters: `ResendEmailChannel`, `TwilioSmsChannel`,
  `DatabaseInAppChannel` (each shipped as its own slice with vendor
  credentials, BAA review where PHI-capable, and observability hooks).
- Boot wiring: parallel agent is refactoring
  `apps/web/src/server/bootstrap.ts` and `apps/worker/src/main.ts` to
  call `configureNotifications({ channel })` at process startup.
- Outbox → notification drain: a worker that maps domain events
  (`billing.invoice.payment_failed.v1`, etc.) to the template ids in
  the registry plus a recipient resolver.

## References

- Code: `packages/notifications/src/index.ts`
- Code: `packages/notifications/src/ports/notification-channel.ts`
- Code: `packages/notifications/src/templates/template-registry.ts`
- Code: `packages/notifications/src/adapters/in-memory-notification-channel.ts`
- Sibling pattern: `packages/billing/src/ports/stripe-invoice-port.ts`,
  `packages/package-capture/src/storage/package-photo-storage.ts`
- Companion: ADR 0021 — Document storage port
