-- Portal password history (ADR-0033, slice 3).
--
-- The `password_history` twin for `portal_account`: the anti-reuse
-- window consulted by `ChangePortalPassword`, appended and pruned
-- with the same policy depth operators use.

CREATE TABLE "portal_password_history" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "portalAccountId" UUID NOT NULL,

    "hashedPassword" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_password_history_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "portal_password_history"
    ADD CONSTRAINT "portal_password_history_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "portal_password_history"
    ADD CONSTRAINT "portal_password_history_portalAccountId_fkey"
    FOREIGN KEY ("portalAccountId") REFERENCES "portal_account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "portal_password_history_portalAccountId_createdAt_idx"
    ON "portal_password_history"("portalAccountId", "createdAt");
CREATE INDEX "portal_password_history_organizationId_idx"
    ON "portal_password_history"("organizationId");

-- ---------------------------------------------------------------------------
-- Grants + RLS (standard tenant-isolation policy, literal form)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "portal_password_history"
    TO pharmax_app, pharmax_system;

ALTER TABLE "portal_password_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_password_history" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "portal_password_history"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "portal_password_history" IS
  'Anti-reuse window for portal credentials (twin of password_history). Appended/pruned by ChangePortalPassword with the operator policy depth.';
