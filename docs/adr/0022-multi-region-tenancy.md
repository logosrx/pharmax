# 0022 — Multi-region tenancy seams

- **Status:** Accepted — design only; no implementation work scheduled
- **Date:** 2026-05-25
- **Deciders:** Platform team, Security & Compliance, Pharmacy ops lead
- **Tags:** `tenancy`, `data-residency`, `kms`, `audit`, `futures`

This is a **futures ADR**. Pharmax is single-region by design today and there is
no roadmap commitment to multi-region for the foreseeable future (estimated
3+ years out). The purpose of this document is to name the seams now, so that
when a regulatory or customer requirement forces the move, the architectural
path is obvious and the existing single-region invariants (RLS, audit chain,
envelope encryption) are not silently violated by an under-considered
"just add a replica" change.

Nothing in this ADR authorises code changes. No migrations, no stub packages,
no env vars. The deliverable is the design contract.

## Context

### What single-region looks like today

The Pharmax production topology is a single AWS region in every dimension:

- **One Postgres cluster.** The Prisma singleton lives in
  `packages/database/src/index.ts` and is the only client every package
  imports. There is no replica routing layer.
- **One Redis (planned).** Idempotency keys, rate limits, live counters,
  and queue state share a single regional cache.
- **One S3 bucket region** for envelope-encrypted attachments, labels, and
  package photos.
- **Per-connection tenancy GUC.** `packages/tenancy/src/session-guc.ts`
  calls `SELECT set_config('pharmax.organization_id', ..., true)` as the
  first statement of every command-bus transaction. The RLS baseline
  installed by `20260522060000_rls_baseline` enforces
  `"organizationId" = NULLIF(current_setting('pharmax.organization_id'), '')::uuid`
  on every tenant-scoped table. This contract assumes the connection is
  pinned to the writer that the command will run against; it has no
  notion of "replica" or "wrong region".
- **KMS keys in one region.** `LocalKmsAdapter`
  (`packages/crypto/src/local-kms-adapter.ts`) derives a per-tenant KEK
  via HKDF from a single process seed. The production-bound
  `AwsKmsAdapter` is deferred (see boot guard in
  `apps/web/src/server/bootstrap.ts` and `apps/worker/src/main.ts` —
  both refuse to start in production with the Local adapter). AWS KMS
  keys are inherently regional.
- **Single web tier and single worker tier.** `apps/web/proxy.ts` runs one
  Clerk-protected ingress; `apps/worker/src/main.ts` boots one fleet of
  poll loops (Stripe drain, EasyPost drain, FedEx/UPS tracking, outbox).
- **Single print-agent fleet** per pharmacy site (already physical and
  regional in practice — see ADR on print-agent topology).
- **Single webhook ingress.** Stripe, EasyPost, FedEx, UPS, and Clerk all
  point at one set of URLs hosted in the one region.

### Why single-region is correct today

Three reasons. First, simplicity at current scale: a single Postgres writer
makes the per-tenant audit hash chain trivially single-writer, which is the
property the chain's tamper-evidence claim rests on. Second, the per-connection
GUC is incompatible with naive replica routing — a query that lands on a
replica without the GUC having been set on that connection will fail the RLS
policy with "no rows" rather than "wrong region", which is the worst
diagnostic experience possible. Third, the cost and operational complexity of
a second region (per-region observability, per-region runbooks, vendor
webhook configuration, per-region KMS keys) is unjustified until there is a
non-US tenant demanding it.

### When multi-region becomes a requirement

Likely triggers, in rough order of probability:

1. **Data-residency regulations** — GDPR for EU customers, PIPEDA for
   Canadian customers, the Australian Privacy Principles, or an equivalent
   regulation in a target market. PHI processed in the wrong jurisdiction
   is a compliance breach.
2. **Latency for non-US customers.** Pharmacy workflows (typist → PV1 →
   fill → final → ship) demand sub-100ms feedback at every command click;
   cross-Atlantic round-trips break that.
3. **Disaster-recovery beyond multi-AZ.** A regional AWS outage takes
   Pharmax fully offline today; some customers will require an active or
   warm standby in a second region.
4. **Large-customer requirement.** An enterprise sales motion may surface a
   contract clause demanding regional segregation.
5. **Regulatory diversification.** Defence-in-depth against a single
   regulator's enforcement action affecting global operations.

## Decision (the seams)

Multi-region adoption, when it happens, follows the **tenant-pinned-region**
model: every tenant has exactly one home region, all writes for that tenant
go to that region, and PHI never crosses a regional boundary. The nine seams
below name, for each subsystem, what exists today and what changes when the
trigger fires.

### Seam 1 — Tenant region pinning

At `CreateOrganization` time, the tenant is assigned an immutable
`homeRegion` (`us-east-1`, `eu-west-1`, etc.) recorded as a column on
`Organization`. Once pinned, every write for that tenant routes to that
region. Moving a tenant cross-region is an explicit, audited
`MigrateTenantHomeRegion` system command — rare, operator-initiated, with
its own runbook (data copy, KEK re-wrap, cutover, source teardown).

- **Today:** no `homeRegion` column on `Organization`; the concept is
  unrepresented.
- **Change needed:** one nullable-then-NOT-NULL column on `Organization`,
  a runtime constant `PHARMAX_REGION` set per deployed runtime, and a
  boot-time assertion that the runtime can read the column.

### Seam 2 — Connection-pool routing

Each runtime process is pinned to its own region and will only serve
tenants whose `homeRegion` matches its `PHARMAX_REGION`. The ingress
layer (ALB / API Gateway / CloudFront) routes by tenant header, subdomain,
or path prefix so the runtime never has to make a cross-region database
call.

- **Today:** one Prisma singleton at `packages/database/src/index.ts`.
- **Change needed:** a region-aware connection factory that returns the
  correct client for the runtime's region, plus a **startup-time
  assertion** at the API boundary (in `resolveOperatorTenancyContext` or
  equivalent) that the resolved tenant's `homeRegion` matches the
  runtime's `PHARMAX_REGION`. This is defence in depth: RLS already
  prevents row leakage, but a misrouted request would otherwise return
  `NotFoundError` rather than a clear "wrong region — try
  https://eu.pharmax/..." redirect. The misrouted-request signal is what
  operators need to debug ingress misconfiguration.

### Seam 3 — KMS regionality

AWS KMS keys are regional. The per-tenant KEK derivation in
`LocalKmsAdapter` uses one seed today; the deferred `AwsKmsAdapter` must
take **a KMS key in the tenant's home region** as constructor input. The
correct boot-time wiring is "the AwsKmsAdapter constructed in this runtime
uses the KMS key in this runtime's region" — not "tenant lookup picks a
key per request". That gives a structural guarantee: a misrouted
cross-region request cannot decrypt the tenant's PHI because the wrong
region's account does not hold the KMS key at all.

- **Today:** one HKDF seed; `LocalKmsAdapter` only.
- **Change needed:** `AwsKmsAdapter` ships with an explicit `region`
  constructor parameter (a Phase 6 prerequisite regardless of
  multi-region); the boot wiring in `apps/web/src/server/bootstrap.ts`
  and `apps/worker/src/main.ts` selects the region from
  `PHARMAX_REGION`; the existing `NODE_ENV === "production"` guard
  extends to "and `PHARMAX_REGION` is set".

### Seam 4 — Audit hash chain regionality

The per-tenant hash chain in `audit_log` + `audit_chain_state` (installed
by `20260522190000_audit_chain`) assumes a single writer per
`(organizationId)`. Tenant pinning satisfies this automatically: tenant
X's chain only ever exists in tenant X's home region, and the
`(organizationId, seq)` unique constraint cannot collide because no other
region writes to it.

- **Today:** single region trivially satisfies the invariant.
- **Change needed:** **structurally nothing.** The explicit rule is
  "`audit_log` rows do not replicate cross-region." The canonical
  cross-region audit footprint is the signed Merkle-root manifest
  archived to S3 (a deferred capability), which carries
  tamper-evidence without carrying audit-log payloads.

### Seam 5 — Outbox and worker drains

The `event_outbox` table is per-region, and workers in region X drain
tenants in region X. Cross-region scenarios (e.g. central billing
aggregation for tenants in multiple regions) require an **explicit
cross-region event-relay outbox handler** that reads from the local
region, transforms to a non-PHI projection, and publishes to the central
region — never a database-level read replica that quietly exposes PHI.

- **Today:** one worker fleet in `apps/worker/src/main.ts` with one
  outbox loop and one set of per-vendor handlers in
  `apps/worker/src/drains/`.
- **Change needed:** per-region worker fleets each booting the same
  `createOutboxDrainer` against their regional Prisma client. The
  documented anti-pattern: a worker in region A subscribing to the
  outbox in region B. Cross-region work uses a relay handler with an
  explicit transformation step that strips PHI.

### Seam 6 — Webhook ingress

Stripe, EasyPost, FedEx, UPS, and Clerk all need delivery URLs. The
options are:

1. **Per-region webhook URLs** — the vendor stores a per-account URL
   per region. Supported by every vendor in use; simplest mental model.
   **Recommended default.**
2. **Single-region webhook receiver that relays** to the correct region.
   Extra hop, simpler vendor configuration, but the relay layer becomes
   a cross-region single point of failure for inbound events.
3. **CloudFront/Route53 latency routing** — transparent to the vendor.
   Adds a routing layer to maintain and tests less obvious failure
   modes.

- **Today:** single URL per vendor.
- **Change needed:** per-vendor decision. For Stripe specifically, the
  unit of registration is the Connect account (when Connect ships) or
  the platform-level webhook for direct charges; both can be per-region
  URLs. Document each vendor's webhook configuration in a runbook —
  this is the kind of detail that gets lost in a hand-off.

### Seam 7 — Read replicas for reports

Already a Phase 6 item ("Read replicas + reporting replica routing").
Multi-region adds two flavours: a **regional reporting replica** per
region (used by `@pharmax/reporting` for tenant-local reports) and
optionally **one cross-region analytics replica** for an operator that
needs cross-region aggregates. The cross-region replica is opt-in,
non-PHI-aggregated only, and explicitly carved out from the "PHI never
leaves home region" rule under the conditions documented in Seam 9.

- **Today:** nothing; reports run against the writer.
- **Change needed:** a second Prisma client instance scoped to a
  read-only connection string, surfaced as the routing decision at the
  `@pharmax/reporting` layer (not at the call site).

### Seam 8 — Search index regionality

There is no real search service today (Elastic / OpenSearch is absent;
patient search is the blind-index pattern from
`packages/crypto/src/blind-index.ts`, keyed Postgres-side). When a real
search service ships, its index lives in the tenant's home region for the
same reason Postgres does. The blind-index pattern in use today already
has this property structurally — the HMAC keys are tenant-scoped through
`deriveSearchKey`.

- **Today:** blind-index search piggy-backs on the regional Postgres.
- **Change needed:** when a dedicated search service ships, the per-tenant
  index must live in the tenant's home region; the search cluster is per-
  region.

### Seam 9 — PHI cross-border data flow (the compliance line)

This is the rule the other eight seams enforce. **PHI never leaves the
tenant's home region.** The only cross-region data flows permitted:

- **Signed audit-chain Merkle-root manifests** (NOT raw audit data) for
  tamper-evidence — when the S3-archived manifest capability ships.
- **Aggregated, non-row-level reporting counts** for cross-region
  business analytics — explicit opt-in per tenant, documented in the
  agreement.
- **Non-PHI operational telemetry** (Sentry, OTel traces) where the
  vendor-side PII redaction has been audited.

Any other cross-region flow needs operator sign-off and an ADR
amendment. This is the compliance line; everything else is plumbing.

## Consequences

**Easier.** A data-residency story for EU, Canadian, and Australian
customers. Latency parity for non-US users. Disaster-recovery
diversification beyond multi-AZ. Natural alignment with the existing
per-tenant-everything design — the seams are additive, not
contradictory.

**Harder.** Operational complexity multiplies: per-region deploys,
per-region observability, per-region runbooks, per-region on-call.
Tenant migration across regions is an inherently hard operation (KEK
re-wrap, copy, cutover) and will need a dedicated runbook.
Per-vendor webhook configuration becomes a setup checklist instead of a
one-time wire-up. Cross-region reporting requires deliberate design
rather than "just join the tables".

**Cost.** Roughly N× the AWS bill where N is the number of regions —
RDS, ElastiCache, ECS Fargate, ALB, KMS, S3, CloudWatch all duplicate.
Engineering cost is deferred: a region-aware connection factory, the
ingress routing layer, per-region observability dashboards, and the
`MigrateTenantHomeRegion` system command are all sized in weeks, not
days, but none of them are required until the trigger fires.

## Migration path (when triggered)

1. Add `Organization.homeRegion` column; backfill every existing tenant
   to the current region.
2. Build the region-aware connection factory inside
   `@pharmax/database`; preserve the singleton import shape so
   downstream packages do not change.
3. Ship `AwsKmsAdapter` with explicit `region` constructor input — a
   Phase 6 prerequisite regardless of multi-region.
4. Add the boot-time assertion (in `apps/web` bootstrap and
   `apps/worker` main) that the runtime's `PHARMAX_REGION` matches the
   tenants the runtime is willing to serve; fail closed.
5. Deploy a second region with **no tenants yet** as a smoke test of
   the ingress routing layer, KMS wiring, and per-region observability.
6. Pin the first non-US tenant to the second region at
   `CreateOrganization` time; run the production traffic shadow for
   one billing cycle before declaring GA.
7. Document the per-vendor webhook configuration in
   `docs/RUNBOOK.md` — Stripe, EasyPost, FedEx, UPS, Clerk each get a
   subsection.
8. Document the cross-region audit-manifest replication design
   (deferred until the first real auditor asks).

## Alternatives Considered

- **Multi-master active-active.** Rejected. The per-connection GUC and
  per-tenant audit hash chain are **single-writer designs by intent**.
  Attempting to make audit-chain writes commute across regions destroys
  tamper-evidence (a chain with two heads is no longer a chain), and
  any conflict-resolution scheme would have to be auditable on its own
  — a problem worse than the one it solves.
- **Cross-region read replicas with cross-region writes via routing.**
  Rejected. Transactional write latency is the binding constraint:
  typists, pharmacists, and dispensers all need <100ms click feedback
  to keep the workflow flowing, and a cross-Atlantic round-trip is an
  order of magnitude over that. The replica reads would be fine; the
  writes would not.
- **Sharding within one region instead of multi-region.** That is a
  different problem (scale, not residency). The seam shape is similar
  — `homeShard` instead of `homeRegion`, per-shard connection factory
  — but the decision driver is throughput, not jurisdiction, and the
  trigger and economics are different. If both pressures appear, this
  ADR's seams compose with sharding rather than substitute for it.

## Open Questions Intentionally Deferred

- **Specific AWS region for the second region.** Depends on which
  non-US tenant signs first; `eu-west-1` and `eu-central-1` are the
  obvious candidates for an EU-first trigger, but the choice belongs
  with the customer signing the contract.
- **Cross-region disaster-recovery RPO/RTO targets.** Depend on
  customer SLA commitments. The shape of the answer (warm standby vs.
  cold backup) drives the cost model.
- **Whether the print-agent fleet is regional.** Probably yes —
  print-agents are already per-pharmacy-site and therefore implicitly
  regional. Confirm at design time.
- **Whether Clerk's regionality story is sufficient.** Depends on
  Clerk's data-residency offerings at the time of the trigger; a
  vendor change is a separate, larger ADR.
- **Cost-allocation model.** One consolidated AWS bill with internal
  per-region tagging, or per-region account isolation. The compliance
  team's audit posture and the finance team's allocation preferences
  decide this jointly.

## References

- Code: `packages/tenancy/src/session-guc.ts` — per-connection GUC writer
- Code: `packages/database/src/index.ts` — the singleton Prisma client
- Code: `packages/crypto/src/local-kms-adapter.ts` — single-seed KEK derivation
- Code: `packages/crypto/src/index.ts` — `KmsAdapter` interface (the seam for `AwsKmsAdapter`)
- Code: `apps/web/src/server/bootstrap.ts`, `apps/worker/src/main.ts` — single-region boot wiring + production guards
- Code: `apps/web/proxy.ts` — single-region ingress
- Code: `apps/worker/src/drains/` — single-region drain assumptions
- Migration: `prisma/migrations/20260522060000_rls_baseline/` — GUC contract
- Migration: `prisma/migrations/20260522190000_audit_chain/` — single-writer audit chain
- Implementation plan: `docs/IMPLEMENTATION_PLAN.md` — Phase 6 (read replicas, Terraform)
- Companion ADRs: `0004-rls-and-tenancy-guc.md`, `0005-envelope-encryption.md`
