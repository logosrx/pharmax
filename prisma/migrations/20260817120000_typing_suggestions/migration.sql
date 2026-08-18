-- AI typing-assist suggestion engine (phase 2 of the typing-assist plan).
--
-- Two tenant-scoped tables:
--
--   1. typing_suggestion_run — one technician-initiated evaluation of
--      one prescription while its order is in TYPING_IN_PROGRESS.
--      Pins the ai_assist_policy / product_ai_guardrail revisions that
--      governed it, records whether the model stage was permitted, and
--      carries the model call's identity (provider, model id, prompt
--      version, input digest) and cost (tokens, latency) once the
--      worker completes. A failed or skipped model stage is a status +
--      reason code on this row — never a silent nothing.
--
--   2. typing_suggestion — one field-level proposal hanging off a run.
--      Deterministic proposals are written synchronously by
--      RequestTypingSuggestions; model proposals are written by the
--      worker after the Bedrock call. A model may propose; only
--      AcceptTypingSuggestion (human-dispatched, order-locked) may
--      touch the prescription row.
--
-- PHI: suggestion targets are restricted to the prescription's
-- STRUCTURED, non-PHI columns (quantities, day counts, refills, DAW,
-- dates, schedule, structured dose fields, catalog strength/form).
-- Free-text sig / notes are never suggestion targets and never stored
-- in either table. Model rationale is PHI-tripwire-screened before
-- persist.

-- ---------------------------------------------------------------------
-- 0. Enums
-- ---------------------------------------------------------------------

CREATE TYPE "TypingSuggestionRunStatus" AS ENUM (
    'PENDING_MODEL',
    'COMPLETED',
    'FAILED',
    'MODEL_SKIPPED'
);

CREATE TYPE "TypingSuggestionSource" AS ENUM (
    'DETERMINISTIC',
    'MODEL'
);

CREATE TYPE "TypingSuggestionStatus" AS ENUM (
    'PROPOSED',
    'ACCEPTED',
    'DISMISSED',
    'SUPERSEDED'
);

-- ---------------------------------------------------------------------
-- 1. typing_suggestion_run
-- ---------------------------------------------------------------------

CREATE TABLE "typing_suggestion_run" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "prescriptionId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,

    "status" "TypingSuggestionRunStatus" NOT NULL,

    "modelSuggestionsPermitted" BOOLEAN NOT NULL,
    "modelSkipReasonCode" TEXT,

    "policyVersion" INTEGER,
    "guardrailVersion" INTEGER,
    "minConfidencePercent" INTEGER,

    "deterministicFindingCount" INTEGER NOT NULL,

    "provider" TEXT,
    "modelId" TEXT,
    "promptVersion" INTEGER,
    "inputDigestSha256" CHAR(64),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,

    "sigOmittedByPhiTripwire" BOOLEAN NOT NULL DEFAULT false,

    "failureCode" TEXT,
    "completedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "typing_suggestion_run_pkey" PRIMARY KEY ("id")
);

-- Confidence snapshot is a percentage when present.
ALTER TABLE "typing_suggestion_run"
    ADD CONSTRAINT "typing_suggestion_run_confidence_percent_range"
    CHECK ("minConfidencePercent" IS NULL
        OR ("minConfidencePercent" >= 0 AND "minConfidencePercent" <= 100));

-- A terminal MODEL_SKIPPED run must say why; a FAILED run must carry a
-- failure code. "It didn't run and nobody knows why" is the exact
-- state these constraints exist to make unrepresentable.
ALTER TABLE "typing_suggestion_run"
    ADD CONSTRAINT "typing_suggestion_run_skip_reason_required"
    CHECK ("status" <> 'MODEL_SKIPPED' OR "modelSkipReasonCode" IS NOT NULL);
ALTER TABLE "typing_suggestion_run"
    ADD CONSTRAINT "typing_suggestion_run_failure_code_required"
    CHECK ("status" <> 'FAILED' OR "failureCode" IS NOT NULL);

CREATE INDEX "typing_suggestion_run_organizationId_orderId_createdAt_idx"
    ON "typing_suggestion_run"("organizationId", "orderId", "createdAt" DESC);
CREATE INDEX "typing_suggestion_run_organizationId_status_createdAt_idx"
    ON "typing_suggestion_run"("organizationId", "status", "createdAt");

ALTER TABLE "typing_suggestion_run" ADD CONSTRAINT "typing_suggestion_run_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typing_suggestion_run" ADD CONSTRAINT "typing_suggestion_run_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typing_suggestion_run" ADD CONSTRAINT "typing_suggestion_run_prescriptionId_fkey"
    FOREIGN KEY ("prescriptionId") REFERENCES "prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typing_suggestion_run" ADD CONSTRAINT "typing_suggestion_run_requestedByUserId_fkey"
    FOREIGN KEY ("requestedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 2. typing_suggestion
-- ---------------------------------------------------------------------

CREATE TABLE "typing_suggestion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "prescriptionId" UUID NOT NULL,

    "source" "TypingSuggestionSource" NOT NULL,
    "findingCode" TEXT,
    "field" TEXT NOT NULL,

    "currentValue" JSONB,
    "suggestedValue" JSONB,

    "rationale" TEXT NOT NULL,
    "confidencePercent" INTEGER,

    "status" "TypingSuggestionStatus" NOT NULL DEFAULT 'PROPOSED',

    "resolvedByUserId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "dismissReasonCode" TEXT,
    "appliedCommandLogId" UUID,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "typing_suggestion_pkey" PRIMARY KEY ("id")
);

-- Model confidence is a percentage when present.
ALTER TABLE "typing_suggestion"
    ADD CONSTRAINT "typing_suggestion_confidence_percent_range"
    CHECK ("confidencePercent" IS NULL
        OR ("confidencePercent" >= 0 AND "confidencePercent" <= 100));

-- Every rejection carries a reason code (workflow-safety rule); a
-- resolved row must say who resolved it.
ALTER TABLE "typing_suggestion"
    ADD CONSTRAINT "typing_suggestion_dismiss_reason_required"
    CHECK ("status" <> 'DISMISSED' OR "dismissReasonCode" IS NOT NULL);
ALTER TABLE "typing_suggestion"
    ADD CONSTRAINT "typing_suggestion_resolver_required"
    CHECK ("status" NOT IN ('ACCEPTED', 'DISMISSED') OR "resolvedByUserId" IS NOT NULL);

CREATE INDEX "typing_suggestion_organizationId_orderId_status_idx"
    ON "typing_suggestion"("organizationId", "orderId", "status");
CREATE INDEX "typing_suggestion_organizationId_runId_idx"
    ON "typing_suggestion"("organizationId", "runId");

ALTER TABLE "typing_suggestion" ADD CONSTRAINT "typing_suggestion_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typing_suggestion" ADD CONSTRAINT "typing_suggestion_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "typing_suggestion_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typing_suggestion" ADD CONSTRAINT "typing_suggestion_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typing_suggestion" ADD CONSTRAINT "typing_suggestion_prescriptionId_fkey"
    FOREIGN KEY ("prescriptionId") REFERENCES "prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typing_suggestion" ADD CONSTRAINT "typing_suggestion_resolvedByUserId_fkey"
    FOREIGN KEY ("resolvedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 3. Grants. SELECT + INSERT + UPDATE only: runs progress through
--    statuses and suggestions through their lifecycle via UPDATE.
--    DELETE is granted to neither role — a proposal a technician
--    dismissed is evidence, not clutter; it stays for the auditor.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON TABLE "typing_suggestion_run" TO pharmax_app, pharmax_system;
REVOKE DELETE ON TABLE "typing_suggestion_run" FROM pharmax_app, pharmax_system;

GRANT SELECT, INSERT, UPDATE ON TABLE "typing_suggestion" TO pharmax_app, pharmax_system;
REVOKE DELETE ON TABLE "typing_suggestion" FROM pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 4. Row-level security: enabled AND forced, split per-command
--    policies — same posture as every tenant-scoped table.
-- ---------------------------------------------------------------------

ALTER TABLE "typing_suggestion_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "typing_suggestion_run" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON "typing_suggestion_run"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "typing_suggestion_run"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_update ON "typing_suggestion_run"
  FOR UPDATE
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

ALTER TABLE "typing_suggestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "typing_suggestion" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON "typing_suggestion"
  FOR SELECT
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_insert ON "typing_suggestion"
  FOR INSERT
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_update ON "typing_suggestion"
  FOR UPDATE
  USING (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('pharmax.system_context', true) = 'on'
    OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------
-- 5. Table comments.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "typing_suggestion_run" IS
  'One technician-initiated AI typing-assist evaluation of one prescription while its order is in TYPING_IN_PROGRESS. Pins the ai_assist_policy/product_ai_guardrail revisions that governed it, whether the model stage was permitted (and why not), and the model call''s identity and cost once the worker completes. FAILED requires failureCode, MODEL_SKIPPED requires modelSkipReasonCode — no silent non-runs. No PHI: structured references and model telemetry only. No DELETE grant.';

COMMENT ON TABLE "typing_suggestion" IS
  'One field-level typing-fix proposal hanging off a typing_suggestion_run. Targets only structured non-PHI prescription columns; free-text sig/notes are never targets. Deterministic rows are written synchronously, model rows by the worker after guardrail/confidence filtering. Lifecycle PROPOSED -> ACCEPTED/DISMISSED/SUPERSEDED; DISMISSED requires a reason code, resolution requires a user stamp (both CHECK-enforced). Only AcceptTypingSuggestion applies a proposal to the prescription. No DELETE grant: a dismissed proposal is audit evidence.';
