-- Phase 6 hardening: distributed-trace context propagation across
-- DB-backed async boundaries. Producers persist the active W3C
-- traceparent on the queue row; the consuming process (worker outbox
-- drainer, worker webhook-delivery drainer, print-agent claim loop)
-- resumes the trace from it. Nullable TEXT adds — metadata-only lock,
-- no table rewrite, no backfill (historical rows simply have no
-- producer trace context).

ALTER TABLE "event_outbox" ADD COLUMN "traceparent" TEXT;

ALTER TABLE "webhook_delivery" ADD COLUMN "traceparent" TEXT;

ALTER TABLE "print_job" ADD COLUMN "traceparent" TEXT;
