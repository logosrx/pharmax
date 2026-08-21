-- ---------------------------------------------------------------------
-- Prescriber-to-client roster, and client scope on the portal session.
--
-- WHY. One prescriber commonly writes for several client practices, and
-- each of those practices is a separate billing and patient-roster
-- boundary: `patient.clinicId`, `pricing_rule.clinicId` and
-- `invoice.clinicId` are all clinic-keyed. So "which client is this
-- prescriber acting for right now" is not a display preference — it
-- decides which patients are visible and which client is invoiced for
-- the fill.
--
-- Two tables answer two different questions:
--
--   clinic_provider_affiliation   MAY they act for that client at all
--   portal_session.activeClinicId WHICH one are they acting for now
--
-- The selected client lives on the session because a session row is the
-- only scope proof the server can trust. A clinic id in a request body
-- is caller-controlled, and this is precisely the boundary where that
-- distinction is load-bearing.
--
-- THE TENANCY GAP THIS CLOSES BY CONVENTION, NOT BY RLS. The policy
-- below filters by organization, as every policy in this schema does.
-- Two clients of the SAME pharmacy share an organizationId, so RLS
-- cannot separate them and does not try to. Cross-tenant reads are
-- stopped here; keeping client A's roster out of client B's portal is
-- enforced one layer up, in `readInClinicScope`. Stated explicitly
-- because a reader who assumes RLS covers the client boundary will
-- write a leaking query and believe it is safe.
--
-- PHI: none. Prescriber identity is public NPI-registry data and no
-- patient row is referenced.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. Enums.
-- ---------------------------------------------------------------------

CREATE TYPE "ClinicProviderAffiliationStatus" AS ENUM ('ACTIVE', 'ENDED');

-- Portal only. Switching client revokes the current session and mints a
-- new one rather than editing scope in place, so one session token
-- means one client for its whole life and an in-flight request can
-- never observe the scope changing underneath it.
--
-- Safe inside Prisma's migration transaction on PG 12+: adding a value
-- is transactional, and this migration does not USE the new value.
ALTER TYPE "AuthSessionRevokeReason" ADD VALUE 'SCOPE_CHANGED';

-- ---------------------------------------------------------------------
-- 2. clinic_provider_affiliation
-- ---------------------------------------------------------------------

CREATE TABLE "clinic_provider_affiliation" (
    -- No DB-side default: Prisma's @default(uuid()) generates the value
    -- client-side, matching every other table in this schema.
    "id"             UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clinicId"       UUID NOT NULL,
    "providerId"     UUID NOT NULL,

    "status" "ClinicProviderAffiliationStatus" NOT NULL DEFAULT 'ACTIVE',

    "affiliatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- ENDED rows only; see the CHECK constraint below.
    "endedAt"       TIMESTAMP(3),
    "endedReason"   TEXT,
    "endedByUserId" UUID,

    "createdByUserId" UUID NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinic_provider_affiliation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "clinic_provider_affiliation"
    ADD CONSTRAINT "clinic_provider_affiliation_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clinic_provider_affiliation"
    ADD CONSTRAINT "clinic_provider_affiliation_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "clinic"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clinic_provider_affiliation"
    ADD CONSTRAINT "clinic_provider_affiliation_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "provider"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clinic_provider_affiliation"
    ADD CONSTRAINT "clinic_provider_affiliation_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clinic_provider_affiliation"
    ADD CONSTRAINT "clinic_provider_affiliation_endedByUserId_fkey"
    FOREIGN KEY ("endedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- One row per (client, prescriber). Re-affiliating flips an ENDED row
-- back to ACTIVE rather than inserting a duplicate, so affiliation
-- history stays on one row and this key stays an identity rather than
-- "the most recent attempt". Also satisfies the organizationId-first
-- index requirement (R3 in check-prisma-schema).
--
-- Two of the three names below are hand-truncated to Prisma's own
-- 63-character form (`_provide_key`, `_statu_idx`) so replaying this
-- migration reproduces schema.prisma byte-for-byte. Spelling them in
-- full would land in drift-baseline.txt as an accepted rename, and an
-- identifier we control is not divergence worth accepting.
CREATE UNIQUE INDEX "clinic_provider_affiliation_organizationId_clinicId_provide_key"
    ON "clinic_provider_affiliation"("organizationId", "clinicId", "providerId");

-- "Who prescribes for this client" — the ops roster view. 62 chars,
-- so this one needs no truncation.
CREATE INDEX "clinic_provider_affiliation_organizationId_clinicId_status_idx"
    ON "clinic_provider_affiliation"("organizationId", "clinicId", "status");

-- "Which clients may this prescriber act for" — the portal chooser,
-- run on every portal sign-in.
CREATE INDEX "clinic_provider_affiliation_organizationId_providerId_statu_idx"
    ON "clinic_provider_affiliation"("organizationId", "providerId", "status");

-- An affiliation is either live with nothing to explain, or ended with
-- a full account of who ended it, when, and why. A half-ended row —
-- status flipped but no reason recorded — is the state that makes an
-- access review unanswerable, so the database refuses to hold it.
ALTER TABLE "clinic_provider_affiliation"
    ADD CONSTRAINT "clinic_provider_affiliation_ended_fields_consistent"
    CHECK (
        ("status" = 'ACTIVE'
            AND "endedAt" IS NULL
            AND "endedReason" IS NULL
            AND "endedByUserId" IS NULL)
        OR
        ("status" = 'ENDED'
            AND "endedAt" IS NOT NULL
            AND "endedReason" IS NOT NULL
            AND "endedByUserId" IS NOT NULL)
    );

GRANT SELECT, INSERT, UPDATE ON TABLE "clinic_provider_affiliation"
    TO pharmax_app, pharmax_system;

-- DELETE is granted to neither role. Ending an affiliation is a status
-- transition with a reason and an actor; deleting the row would erase
-- the answer to "who was allowed to prescribe for this client last
-- March", which is exactly what an access review asks.

ALTER TABLE "clinic_provider_affiliation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinic_provider_affiliation" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "clinic_provider_affiliation"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "clinic_provider_affiliation" IS
  'Which client practices a prescriber may write for. One row per (client, prescriber); re-affiliating flips ENDED back to ACTIVE. Grants the right to act for a client; portal_session.activeClinicId records which one is currently selected. Org-scoped by RLS, which does NOT separate two clients of one pharmacy — that boundary is enforced by readInClinicScope.';

-- ---------------------------------------------------------------------
-- 3. portal_session.activeClinicId
--
-- Nullable for exactly one window: between authenticating and choosing,
-- when the prescriber has more than one active affiliation. A
-- single-affiliation prescriber is minted already scoped and never sees
-- null. `getCurrentPortalIdentity` returns a discriminated result so
-- that window cannot reach a data read — only the chooser page accepts
-- the unscoped variant.
--
-- Not backfilled. Every pre-existing session predates client scoping
-- and will resolve as unscoped, sending the prescriber through the
-- chooser once. Revoking them instead would sign every portal user out
-- on deploy to save them one click, which is the worse trade.
-- ---------------------------------------------------------------------

ALTER TABLE "portal_session" ADD COLUMN "activeClinicId" UUID;

ALTER TABLE "portal_session"
    ADD CONSTRAINT "portal_session_activeClinicId_fkey"
    FOREIGN KEY ("activeClinicId") REFERENCES "clinic"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deactivating a client must revoke every session still acting for it,
-- or a prescriber keeps a live scope into a client the pharmacy has
-- just switched off. Postgres does not index a foreign key for you.
CREATE INDEX "portal_session_activeClinicId_revokedAt_idx"
    ON "portal_session"("activeClinicId", "revokedAt");

COMMENT ON COLUMN "portal_session"."activeClinicId" IS
  'The client practice this portal session is acting for — the server-side scope proof for every portal read. Immutable for the life of the row: switching client revokes with SCOPE_CHANGED and mints a new session. NULL only between authenticating and choosing, for a prescriber with multiple active affiliations.';
