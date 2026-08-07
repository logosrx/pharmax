-- CreateEnum
CREATE TYPE "ComplianceAiDraftKind" AS ENUM ('CONTROL_DESCRIPTION', 'CRITERION_MAPPING', 'REMEDIATION_PLAN');

-- CreateEnum
CREATE TYPE "ComplianceAiDraftStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'EXPIRED');

-- CreateTable
CREATE TABLE "compliance_ai_draft" (
    "id" UUID NOT NULL,
    "kind" "ComplianceAiDraftKind" NOT NULL,
    "status" "ComplianceAiDraftStatus" NOT NULL DEFAULT 'PENDING',
    "controlId" UUID,
    "checkId" UUID,
    "taskId" UUID,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "inputDigestSha256" CHAR(64) NOT NULL,
    "inputSummary" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "selfReportedConfidence" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "requestedByUserId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reviewedByUserId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReasonCode" TEXT,
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_ai_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "compliance_ai_draft_status_kind_idx" ON "compliance_ai_draft"("status", "kind");

-- CreateIndex
CREATE INDEX "compliance_ai_draft_controlId_kind_idx" ON "compliance_ai_draft"("controlId", "kind");

-- CreateIndex
CREATE INDEX "compliance_ai_draft_requestedByUserId_idx" ON "compliance_ai_draft"("requestedByUserId");

-- AddForeignKey
ALTER TABLE "compliance_ai_draft" ADD CONSTRAINT "compliance_ai_draft_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "compliance_control"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_ai_draft" ADD CONSTRAINT "compliance_ai_draft_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "compliance_check"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_ai_draft" ADD CONSTRAINT "compliance_ai_draft_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "compliance_task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_ai_draft" ADD CONSTRAINT "compliance_ai_draft_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_ai_draft" ADD CONSTRAINT "compliance_ai_draft_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- Grants.
--
-- Platform-level, like the rest of the compliance control plane (see
-- prisma/migrations/rls-exempt.txt). SELECT + INSERT + UPDATE: the
-- status column moves PENDING -> ACCEPTED / REJECTED / SUPERSEDED /
-- EXPIRED and the review stamps are filled in on that transition.
--
-- DELETE is granted to neither role. A draft is the record of what a
-- model proposed and what a human did about it; deleting the ones
-- that were rejected would leave a history in which every AI
-- suggestion was accepted, which is precisely the question an auditor
-- is asking when they ask it.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON TABLE "compliance_ai_draft"
    TO pharmax_app, pharmax_system;

COMMENT ON TABLE "compliance_ai_draft" IS
  'Model-generated compliance proposals awaiting human review. Inert in every status except ACCEPTED, which only a human command can set. Records provider, model id, prompt version, input digest, requester and reviewer so "which of this did a machine write, and who approved it?" has an answer. PHI-free by construction: prompt inputs come from the compliance tables and docs/ only, never from an order or a patient. No DELETE grant — deleting rejected drafts would leave a history in which every AI suggestion was accepted.';

