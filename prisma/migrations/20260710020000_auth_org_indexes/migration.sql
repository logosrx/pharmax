-- Organization-leading indexes for the phase-6 auth tables.
--
-- These four models were added to the tenancy auto-scope registry
-- (TENANT_SCOPED_MODELS), which means every query against them
-- carries an `organizationId = <tenant>` predicate — both from the
-- Prisma extension and from the RLS policies. Without an
-- organizationId-leading index the planner falls back to per-user
-- index scans + filters (R3 in scripts/check-prisma-schema.ts).
-- auth_session already carries (organizationId, createdAt);
-- login_attempt is registry-excluded (nullable organizationId).

CREATE INDEX "mfa_enrollment_organizationId_idx" ON "mfa_enrollment"("organizationId");
CREATE INDEX "recovery_code_organizationId_idx" ON "recovery_code"("organizationId");
CREATE INDEX "password_history_organizationId_idx" ON "password_history"("organizationId");
CREATE INDEX "password_reset_token_organizationId_idx" ON "password_reset_token"("organizationId");
