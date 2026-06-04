# 0029 — Amazon Aurora PostgreSQL as the managed database platform

- **Status:** Accepted
- **Date:** 2026-06-01
- **Deciders:** Platform team
- **Tags:** data, persistence, infrastructure, aws

## Context

ADR 0003 fixed PostgreSQL + Prisma as the transactional source of truth and
ADR 0007 built the twenty-step command bus directly on Postgres concurrency
primitives. When we moved from a single-instance Amazon RDS for PostgreSQL
(`infra/terraform/modules/rds`) to a production-grade managed platform we had
to choose between three AWS options the brief allowed: RDS for PostgreSQL
(single instance), **Amazon Aurora PostgreSQL-Compatible Edition**, and
**Amazon Aurora DSQL**.

The decision is constrained by primitives the codebase already depends on:

- `SELECT … FOR UPDATE` row locks on the aggregate root in every workflow
  command (ADR 0007).
- `… FOR UPDATE SKIP LOCKED` for the worker queue / outbox / report-schedule
  claims (`apps/worker/src/drains/*`).
- `pg_advisory_xact_lock` to serialize audit hash-chain appends (ADR 0006).
- Postgres Row-Level Security with `SET LOCAL` GUCs for tenant isolation
  (ADR 0004), applied identically on the reporting read path.
- Foreign keys with `ON DELETE RESTRICT` anchoring the audit trail (ADR 0003).
- A read replica to offload heavy report scans
  (`packages/database/reporting-client.ts` consumes `REPORTING_DATABASE_URL`).

## Decision

Adopt **Amazon Aurora PostgreSQL-Compatible Edition** as the managed database
engine for every environment. The Terraform module keeps the directory name
`modules/rds` (Aurora is an Amazon RDS engine, so compliance evidence paths
stay valid) but now provisions an `aws_rds_cluster` with one writer and an
environment-tuned number of reader instances.

- **Capacity is environment-tuned.** Production runs provisioned instances
  (`db.r6g.large` writer + ≥1 reader); dev / staging / DR run Aurora
  Serverless v2 (`db.serverless`, scales between a min/max ACU band). The
  composition auto-derives the mode from `var.environment` unless an operator
  overrides `aurora_capacity_mode` / `aurora_reader_count`.
- **The reader endpoint powers reporting.** When a reader exists, the
  stack injects `REPORTING_DATABASE_URL` (the Aurora reader endpoint) into the
  web + worker tasks so report scans never compete with live workflow
  transactions on the writer. With zero readers the env var is omitted and
  reports read the primary (no regression).
- Storage encryption (CMK), TLS-only (`rds.force_ssl = 1` cluster parameter),
  isolated-subnet placement, Performance Insights, Enhanced Monitoring, and
  the AWS-managed master-user secret (`manage_master_user_password`) all carry
  over from the previous RDS module unchanged.

## Consequences

**Easier:**

- Zero application changes — Aurora is 100% PostgreSQL-compatible, so every
  `FOR UPDATE`, advisory lock, RLS policy, and FK works as written.
- A real reader endpoint finally backs the reporting-replica design that was
  already coded but had no replica to point at.
- 6-way storage replication across 3 AZs, ~30s failover, storage that
  auto-scales to 128 TiB, and a clean path to Aurora Global Database for the
  multi-region posture (ADR 0022).

**Harder / accepted costs:**

- Aurora costs more than a single RDS instance at low utilization; Serverless
  v2 in non-prod mitigates this by scaling toward idle.
- CloudWatch metrics differ: Aurora has no `FreeStorageSpace`, so we watch
  `FreeableMemory` on the writer and `AuroraReplicaLag` (milliseconds) at the
  cluster level.
- The restore drill is now cluster-based
  (`aws rds restore-db-cluster-to-point-in-time` / from snapshot) rather than
  instance-based; the restore-drill runbook must be updated accordingly.

## Alternatives Considered

- **Single-instance RDS for PostgreSQL.** Works functionally, but the reader
  endpoint is fake (it returns the writer address), failover is slower
  (60–120s), and it has no path to a cross-region replica without a manual
  snapshot export. Rejected as not "enterprise" enough for the brief.
- **Amazon Aurora DSQL.** A distributed SQL engine with optimistic concurrency
  control and **no** `SELECT … FOR UPDATE`, no advisory locks, no RLS, and only
  limited foreign-key support. Adopting it would require rewriting the entire
  workflow-safety model (ADR 0007) around OCC and re-implementing tenancy
  without RLS (ADR 0004). Disqualified outright.

## References

- ADR 0003 — PostgreSQL + Prisma as the transactional source of truth
- ADR 0004 — Multi-tenancy via Postgres RLS
- ADR 0006 — Hash-chained audit log
- ADR 0007 — Twenty-step command-bus contract
- ADR 0022 — Multi-region tenancy
- `infra/terraform/modules/rds/` — the Aurora cluster module
- `packages/database/src/reporting-client.ts` — `REPORTING_DATABASE_URL` consumer
- `infra/terraform/README.md` § "Assembling DATABASE_URL"
