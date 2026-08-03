-- Compliance control plane (SOC 2 + HIPAA) — schema.prisma §10.
--
-- Turns the control program that currently lives in docs/soc2/*.md
-- into a ledger the platform continuously re-verifies. Markdown
-- cannot tell you when a control STOPS operating; these tables can.
--
-- Platform-level by construction. Every table here is listed in
-- prisma/migrations/rls-exempt.txt and registered in
-- TENANT_EXCLUDED_MODELS (@pharmax/tenancy), because the program
-- being evidenced is Pharmax-the-operator's rather than any one
-- pharmacy tenant's: "is RLS still enabled on every tenant table"
-- has no organizationId, and the per-org probes (audit-chain
-- verification) span every tenant in a single run.
--
-- This follows the precedent recorded in packages/security/src/
-- break-glass/SCHEMA.md §"Audit surface": rather than anchor rows to
-- a synthetic "platform org" — which would weaken the per-tenant
-- audit hash chain — these tables ARE the append-only evidence
-- ledger, enforced at the grant layer in section 4 below.
--
-- Where a run or exception names the tenant it examined it uses an
-- unlinked "subjectOrganizationId" uuid, deliberately NOT a foreign
-- key, so (a) evidence for a closed audit period survives tenant
-- offboarding and (b) no FK invites the cross-tenant join RLS exists
-- to prevent.
--
-- PHI: none. Probes report structural facts, counts, and opaque
-- uuids; the PHI-free guarantee on "summary" / "details" is part of
-- the probe contract in @pharmax/compliance.

-- ---------------------------------------------------------------------
-- 1. Enums.
-- ---------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "ComplianceFramework" AS ENUM ('SOC2_TSC', 'HIPAA_SECURITY', 'HIPAA_PRIVACY', 'HIPAA_BREACH');

-- CreateEnum
CREATE TYPE "ComplianceControlStatus" AS ENUM ('IMPLEMENTED', 'PARTIAL', 'PLANNED', 'DEPRECATED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ComplianceCadence" AS ENUM ('CONTINUOUS', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'ON_CHANGE', 'PER_EVENT');

-- CreateEnum
CREATE TYPE "ComplianceCheckSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ComplianceCheckOutcome" AS ENUM ('PASS', 'FAIL', 'ERROR', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ComplianceTaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED');

-- ---------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------

-- CreateTable
CREATE TABLE "compliance_criterion" (
    "id" UUID NOT NULL,
    "framework" "ComplianceFramework" NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "requirementText" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_criterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_control" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ownerRole" TEXT NOT NULL,
    "status" "ComplianceControlStatus" NOT NULL DEFAULT 'PLANNED',
    "cadence" "ComplianceCadence" NOT NULL,
    "notes" TEXT,
    "implementationRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "replacedByControlId" UUID,
    "lastSignedOffAt" TIMESTAMP(3),
    "lastSignedOffByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_control_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_control_criterion" (
    "id" UUID NOT NULL,
    "controlId" UUID NOT NULL,
    "criterionId" UUID NOT NULL,
    "acceptedFromAiDraftId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_control_criterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_check" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "ComplianceCheckSeverity" NOT NULL,
    "cadence" "ComplianceCadence" NOT NULL,
    "intervalMinutes" INTEGER,
    "automated" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastOutcome" "ComplianceCheckOutcome",
    "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_check_control" (
    "id" UUID NOT NULL,
    "checkId" UUID NOT NULL,
    "controlId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_check_control_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_check_run" (
    "id" UUID NOT NULL,
    "checkId" UUID NOT NULL,
    "checkCode" TEXT NOT NULL,
    "outcome" "ComplianceCheckOutcome" NOT NULL,
    "severityAtRun" "ComplianceCheckSeverity" NOT NULL,
    "subjectOrganizationId" UUID,
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "detailsVersion" INTEGER NOT NULL DEFAULT 1,
    "digestSha256" TEXT NOT NULL,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_check_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_check_exception" (
    "id" UUID NOT NULL,
    "checkId" UUID NOT NULL,
    "subjectOrganizationId" UUID,
    "reasonCode" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "approvedByUserId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_check_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_task" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "controlId" UUID,
    "checkId" UUID,
    "sourceCheckRunId" UUID,
    "status" "ComplianceTaskStatus" NOT NULL DEFAULT 'OPEN',
    "severity" "ComplianceCheckSeverity" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "assignedToUserId" UUID,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" UUID,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_task_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. Indexes and foreign keys.
-- ---------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "compliance_criterion_framework_category_idx" ON "compliance_criterion"("framework", "category");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_criterion_framework_code_key" ON "compliance_criterion"("framework", "code");

-- CreateIndex
CREATE INDEX "compliance_control_status_ownerRole_idx" ON "compliance_control"("status", "ownerRole");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_control_code_key" ON "compliance_control"("code");

-- CreateIndex
CREATE INDEX "compliance_control_criterion_criterionId_idx" ON "compliance_control_criterion"("criterionId");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_control_criterion_controlId_criterionId_key" ON "compliance_control_criterion"("controlId", "criterionId");

-- CreateIndex
CREATE INDEX "compliance_check_enabled_nextRunAt_idx" ON "compliance_check"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "compliance_check_lastOutcome_severity_idx" ON "compliance_check"("lastOutcome", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_check_code_key" ON "compliance_check"("code");

-- CreateIndex
CREATE INDEX "compliance_check_control_controlId_idx" ON "compliance_check_control"("controlId");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_check_control_checkId_controlId_key" ON "compliance_check_control"("checkId", "controlId");

-- CreateIndex
CREATE INDEX "compliance_check_run_checkId_observedAt_idx" ON "compliance_check_run"("checkId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "compliance_check_run_outcome_observedAt_idx" ON "compliance_check_run"("outcome", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "compliance_check_run_subjectOrganizationId_observedAt_idx" ON "compliance_check_run"("subjectOrganizationId", "observedAt" DESC);

-- CreateIndex
CREATE INDEX "compliance_check_exception_checkId_expiresAt_idx" ON "compliance_check_exception"("checkId", "expiresAt");

-- CreateIndex
CREATE INDEX "compliance_task_status_dueAt_idx" ON "compliance_task"("status", "dueAt");

-- CreateIndex
CREATE INDEX "compliance_task_assignedToUserId_status_idx" ON "compliance_task"("assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "compliance_task_checkId_status_idx" ON "compliance_task"("checkId", "status");

-- AddForeignKey
ALTER TABLE "compliance_control" ADD CONSTRAINT "compliance_control_replacedByControlId_fkey" FOREIGN KEY ("replacedByControlId") REFERENCES "compliance_control"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_control" ADD CONSTRAINT "compliance_control_lastSignedOffByUserId_fkey" FOREIGN KEY ("lastSignedOffByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_control_criterion" ADD CONSTRAINT "compliance_control_criterion_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "compliance_control"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_control_criterion" ADD CONSTRAINT "compliance_control_criterion_criterionId_fkey" FOREIGN KEY ("criterionId") REFERENCES "compliance_criterion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_check_control" ADD CONSTRAINT "compliance_check_control_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "compliance_check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_check_control" ADD CONSTRAINT "compliance_check_control_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "compliance_control"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_check_run" ADD CONSTRAINT "compliance_check_run_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "compliance_check"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_check_exception" ADD CONSTRAINT "compliance_check_exception_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "compliance_check"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_check_exception" ADD CONSTRAINT "compliance_check_exception_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_check_exception" ADD CONSTRAINT "compliance_check_exception_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_task" ADD CONSTRAINT "compliance_task_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "compliance_control"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_task" ADD CONSTRAINT "compliance_task_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "compliance_check"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_task" ADD CONSTRAINT "compliance_task_sourceCheckRunId_fkey" FOREIGN KEY ("sourceCheckRunId") REFERENCES "compliance_check_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_task" ADD CONSTRAINT "compliance_task_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_task" ADD CONSTRAINT "compliance_task_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- 4. Grants. Deliberately NARROWER than the baseline.
--
--    No DELETE on ANY table in this section. The whole reason an
--    auditor can trust a continuous-monitoring claim is that the
--    operator cannot quietly remove the runs that failed, the
--    exception that was approved, or the control that was descoped.
--
--    compliance_check_run is INSERT-only: no UPDATE either. A run is
--    an observation at a point in time. Correcting one means
--    recording a new run, never editing the old verdict.
--
--    The two crosswalk tables DO receive DELETE, because a mapping is
--    configuration rather than evidence — a control mis-mapped to the
--    wrong TSC point must be correctable, and the mapping's history
--    is not what an auditor examines. They are also the targets of
--    Prisma's onDelete: Cascade edges; without DELETE those cascades
--    could never fire.
--
--    Both application roles receive the grants because system context
--    is a GUC-based frame rather than a connection-role switch, and
--    the worker (pharmax_system) is what runs the probes while the
--    web app (pharmax_app) serves the posture dashboard.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON TABLE "compliance_criterion"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE ON TABLE "compliance_control"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE ON TABLE "compliance_check"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE ON TABLE "compliance_check_exception"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, UPDATE ON TABLE "compliance_task"
    TO pharmax_app, pharmax_system;

-- Append-only evidence: INSERT + SELECT only.
GRANT SELECT, INSERT ON TABLE "compliance_check_run"
    TO pharmax_app, pharmax_system;

-- Crosswalk configuration: correctable, so DELETE is granted.
GRANT SELECT, INSERT, DELETE ON TABLE "compliance_control_criterion"
    TO pharmax_app, pharmax_system;
GRANT SELECT, INSERT, DELETE ON TABLE "compliance_check_control"
    TO pharmax_app, pharmax_system;

-- ---------------------------------------------------------------------
-- 5. Sanity comments.
-- ---------------------------------------------------------------------

COMMENT ON TABLE "compliance_criterion" IS
  'Published framework requirements (AICPA TSC, 45 CFR Part 164). Reference data seeded from public standards only, per docs/governance/public-sources-reference.md. Retired by superseding, never by editing, so historical control mappings keep resolving to the text in force. Platform-level (RLS-exempt, see rls-exempt.txt).';

COMMENT ON TABLE "compliance_control" IS
  'Pharmax controls — what WE do to satisfy framework criteria. Codes are the stable identifiers published in docs/soc2/controls-inventory.md (CC6.1-2, PI1.1-1). Owner is a role title so accountability survives staff turnover. Append-only at the grant layer: a descoped control flips to DEPRECATED, it is never deleted.';

COMMENT ON TABLE "compliance_control_criterion" IS
  'Crosswalk: control to framework criterion, many-to-many across BOTH frameworks. Makes "which HIPAA requirements have no control mapped?" a query instead of a re-read of a 47KB markdown file. Configuration rather than evidence, so DELETE is granted.';

COMMENT ON TABLE "compliance_check" IS
  'Automated probe definitions plus denormalized scheduler state. The probe LOGIC lives in code (@pharmax/compliance registry, keyed by code) and is never a database-editable expression — a probe is executable logic that must be reviewed, tested, and versioned in git. A row whose code has no registered implementation is reported as a configuration error, never silently skipped.';

COMMENT ON TABLE "compliance_check_control" IS
  'Which controls a check produces evidence for, many-to-many. Configuration rather than evidence, so DELETE is granted.';

COMMENT ON TABLE "compliance_check_run" IS
  'One probe execution: the evidence. INSERT-only at the grant layer (no UPDATE, no DELETE) for the same reason audit_log is immutable. digestSha256 is the canonical sorted-key SHA-256 of details, so an exported evidence file can be recomputed and compared. ERROR is distinct from FAIL: ERROR means no verdict was reached (an observability gap), FAIL means the control is not holding.';

COMMENT ON TABLE "compliance_check_exception" IS
  'Time-boxed, justified acceptance of a failing check. Reason code, written justification, named approver, and expiry are all REQUIRED. expiresAt is non-nullable on purpose: a permanent exception is not an exception, it is an undocumented change to the control design. Revocation sets revokedAt rather than deleting, because the fact an exception once existed is itself evidence.';

COMMENT ON TABLE "compliance_task" IS
  'Remediation work item, opened automatically by the compliance.check.failed.v1 outbox handler or by hand for cadence obligations with no probe. The "and then somebody fixes it" half of continuous monitoring: detecting drift without tracking the response produces findings, not compliance.';
