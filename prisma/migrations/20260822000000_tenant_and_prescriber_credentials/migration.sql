-- ---------------------------------------------------------------------
-- Tenant and prescriber credentials — go-live G-1 and G-2.
--
-- WHY. Pharmax is a software vendor and a HIPAA Business Associate, not
-- a pharmacy. Its customers hold the licences and the DEA registration,
-- and a pharmacy cannot adopt software with nowhere to record them —
-- the gap surfaces as the customer's inspection finding, which makes it
-- Pharmax's commercial problem. Until now `pharmacy_site` carried name,
-- code, timezone, address and phone and no credential field at all, and
-- there was no ship-to-state restriction anywhere in the codebase.
--
-- Four tables and one column:
--
--   provider_dea_registration   supersedes provider.deaNumber
--   provider_state_license      prescriber licence to practise
--   site_credential             the TENANT's licences (G-1)
--   site_authorized_ship_state  where a site may dispense to (G-2)
--   order.destinationState      makes G-2 enforceable everywhere
--
-- PHI: none of it. Prescriber and pharmacy credentials are
-- professional registrations, and a two-letter state is explicitly
-- excluded from HIPAA Safe Harbor's geographic identifiers
-- (§164.514(b)(2)(i)(B) covers subdivisions SMALLER than a state).
--
-- A DEA number is not PHI but IS a controlled-substance prescribing
-- credential: a forensic dump of one is a prescription-fraud tool. It
-- stays redacted from command_log and out of audit metadata, exactly
-- as the column it replaces was.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. Enums.
-- ---------------------------------------------------------------------

-- No EXPIRED member: expiry is a fact about a date and the current
-- time, so it is derived at the point of use. A stored EXPIRED needs a
-- sweeper, and the window between a registration lapsing and the
-- sweeper noticing is exactly when a controlled prescription must not
-- be written. Same reasoning `lot` applies to expired stock.
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'REVOKED', 'SUSPENDED');

CREATE TYPE "DeaRegistrantType" AS ENUM (
    'PRACTITIONER',
    'MID_LEVEL_PRACTITIONER',
    'NARCOTIC_TREATMENT_PROGRAM',
    'DATA_WAIVED_LEGACY',
    'NON_PRESCRIBING'
);

-- ATTESTED is the honest default. There is no free authoritative
-- registry for either DEA registrations or state pharmacy licences —
-- the DEA Active Registrant file is a paid data licence and NABP's
-- verification service is paid, with every state board running its own
-- portal. REGISTRY_FILE exists for a future licensed feed and is why
-- this is a column rather than a boolean.
CREATE TYPE "CredentialVerificationMethod" AS ENUM (
    'ATTESTED',
    'PORTAL_CHECKED',
    'REGISTRY_FILE'
);

CREATE TYPE "SiteCredentialKind" AS ENUM (
    'STATE_PHARMACY_LICENSE',
    'DEA_REGISTRATION',
    'NPI',
    'NCPDP',
    'NABP'
);

-- ---------------------------------------------------------------------
-- 2. provider_dea_registration
-- ---------------------------------------------------------------------

CREATE TABLE "provider_dea_registration" (
    "id"             UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerId"     UUID NOT NULL,

    "deaNumber"           TEXT                NOT NULL,
    "registrantType"      "DeaRegistrantType" NOT NULL,
    -- Defaults to empty: a registration that has not said which
    -- schedules it covers authorizes none of them. The backfill in §7
    -- sets every controlled schedule explicitly, because narrowing
    -- existing authority is the one thing this migration must not do.
    "authorizedSchedules" "ControlledSubstanceSchedule"[] NOT NULL DEFAULT ARRAY[]::"ControlledSubstanceSchedule"[],
    "issuedState"         VARCHAR(2),

    "issuedAt"  DATE,
    -- NULL = not recorded, and does NOT block. A pharmacy migrating on
    -- has DEA numbers with no expiry dates; requiring the date would
    -- block every controlled prescription on day one. A recorded date
    -- in the past DOES block.
    "expiresAt" DATE,

    "status"             "CredentialStatus"             NOT NULL DEFAULT 'ACTIVE',
    "verificationMethod" "CredentialVerificationMethod" NOT NULL DEFAULT 'ATTESTED',
    "verifiedAt"         TIMESTAMP(3),
    "verifiedByUserId"   UUID,

    -- NULL only for rows migrated from provider."deaNumber" in §7.
    "recordedByUserId" UUID,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_dea_registration_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "provider_dea_registration"
    ADD CONSTRAINT "provider_dea_registration_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_dea_registration"
    ADD CONSTRAINT "provider_dea_registration_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "provider"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_dea_registration"
    ADD CONSTRAINT "provider_dea_registration_verifiedByUserId_fkey"
    FOREIGN KEY ("verifiedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_dea_registration"
    ADD CONSTRAINT "provider_dea_registration_recordedByUserId_fkey"
    FOREIGN KEY ("recordedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "provider_dea_registration_organizationId_deaNumber_key"
    ON "provider_dea_registration"("organizationId", "deaNumber");

-- The controlled-substance gate's access path.
CREATE INDEX "provider_dea_registration_organizationId_providerId_status_idx"
    ON "provider_dea_registration"("organizationId", "providerId", "status");

-- Drives the "credentials lapsing soon" report.
CREATE INDEX "provider_dea_registration_organizationId_expiresAt_idx"
    ON "provider_dea_registration"("organizationId", "expiresAt");

-- Letter, then letter-or-9, then seven digits. The second position is
-- NOT restricted to letters: the DEA issues `9` there for registrations
-- under a business name, and the regex this replaces
-- (`^[A-Z]{2}\d{7}$`, in register-provider.ts) silently refused every
-- one of them.
ALTER TABLE "provider_dea_registration"
    ADD CONSTRAINT "provider_dea_registration_number_shape"
    CHECK ("deaNumber" ~ '^[A-Z][A-Z9][0-9]{7}$');

GRANT SELECT, INSERT, UPDATE ON TABLE "provider_dea_registration"
    TO pharmax_app, pharmax_system;

-- No DELETE. A withdrawn registration is REVOKED, not erased: "was
-- this prescriber authorized on the day they wrote this" has to stay
-- answerable for the life of the prescription record.

ALTER TABLE "provider_dea_registration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_dea_registration" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "provider_dea_registration"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "provider_dea_registration" IS
  'A prescriber DEA registration: number, registrant type, authorized schedules, recorded expiry. Supersedes provider."deaNumber", which could only answer "is a string present". Expiry NULL means not recorded and does not block; a past date blocks. Verification is ATTESTED by default — there is no free authoritative DEA registry.';

-- ---------------------------------------------------------------------
-- 3. provider_state_license
-- ---------------------------------------------------------------------

CREATE TABLE "provider_state_license" (
    "id"             UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerId"     UUID NOT NULL,

    "state"         VARCHAR(2) NOT NULL,
    "licenseNumber" TEXT       NOT NULL,
    "licenseType"   TEXT,

    "issuedAt"  DATE,
    "expiresAt" DATE,

    "status"             "CredentialStatus"             NOT NULL DEFAULT 'ACTIVE',
    "verificationMethod" "CredentialVerificationMethod" NOT NULL DEFAULT 'ATTESTED',
    "verifiedAt"         TIMESTAMP(3),
    "verifiedByUserId"   UUID,

    "recordedByUserId" UUID NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_state_license_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "provider_state_license"
    ADD CONSTRAINT "provider_state_license_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_state_license"
    ADD CONSTRAINT "provider_state_license_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "provider"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_state_license"
    ADD CONSTRAINT "provider_state_license_verifiedByUserId_fkey"
    FOREIGN KEY ("verifiedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "provider_state_license"
    ADD CONSTRAINT "provider_state_license_recordedByUserId_fkey"
    FOREIGN KEY ("recordedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-truncated to Prisma's own 63-character form so replaying this
-- migration reproduces schema.prisma byte-for-byte rather than landing
-- in drift-baseline.txt as an accepted rename.
CREATE UNIQUE INDEX "provider_state_license_organizationId_providerId_state_lice_key"
    ON "provider_state_license"("organizationId", "providerId", "state", "licenseNumber");

CREATE INDEX "provider_state_license_organizationId_providerId_status_idx"
    ON "provider_state_license"("organizationId", "providerId", "status");

CREATE INDEX "provider_state_license_organizationId_state_status_idx"
    ON "provider_state_license"("organizationId", "state", "status");

CREATE INDEX "provider_state_license_organizationId_expiresAt_idx"
    ON "provider_state_license"("organizationId", "expiresAt");

ALTER TABLE "provider_state_license"
    ADD CONSTRAINT "provider_state_license_state_shape"
    CHECK ("state" ~ '^[A-Z]{2}$');

GRANT SELECT, INSERT, UPDATE ON TABLE "provider_state_license"
    TO pharmax_app, pharmax_system;

ALTER TABLE "provider_state_license" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_state_license" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "provider_state_license"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "provider_state_license" IS
  'A prescriber state licence to practise. Distinct from the DEA registration: DEA authorizes controlled substances federally, this authorizes practising at all. A current DEA plus a lapsed state licence is the combination worth catching.';

-- ---------------------------------------------------------------------
-- 4. site_credential  (G-1)
-- ---------------------------------------------------------------------

CREATE TABLE "site_credential" (
    "id"             UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId"         UUID NOT NULL,

    "kind"       "SiteCredentialKind" NOT NULL,
    "state"      VARCHAR(2),
    "identifier" TEXT                 NOT NULL,

    "issuedAt"  DATE,
    "expiresAt" DATE,

    "status"             "CredentialStatus"             NOT NULL DEFAULT 'ACTIVE',
    "verificationMethod" "CredentialVerificationMethod" NOT NULL DEFAULT 'ATTESTED',
    "verifiedAt"         TIMESTAMP(3),
    "verifiedByUserId"   UUID,

    "recordedByUserId" UUID NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_credential_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "site_credential"
    ADD CONSTRAINT "site_credential_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_credential"
    ADD CONSTRAINT "site_credential_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_credential"
    ADD CONSTRAINT "site_credential_verifiedByUserId_fkey"
    FOREIGN KEY ("verifiedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_credential"
    ADD CONSTRAINT "site_credential_recordedByUserId_fkey"
    FOREIGN KEY ("recordedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "site_credential_organizationId_siteId_kind_identifier_key"
    ON "site_credential"("organizationId", "siteId", "kind", "identifier");

CREATE INDEX "site_credential_organizationId_siteId_status_idx"
    ON "site_credential"("organizationId", "siteId", "status");

CREATE INDEX "site_credential_organizationId_expiresAt_idx"
    ON "site_credential"("organizationId", "expiresAt");

-- A state pharmacy licence names a state; nothing else does. A state
-- licence with no state is not a record of anything, and an NPI with a
-- state attached invites someone to filter on it.
ALTER TABLE "site_credential"
    ADD CONSTRAINT "site_credential_state_required_for_license"
    CHECK (
        ("kind" = 'STATE_PHARMACY_LICENSE' AND "state" IS NOT NULL AND "state" ~ '^[A-Z]{2}$')
        OR
        ("kind" <> 'STATE_PHARMACY_LICENSE' AND "state" IS NULL)
    );

GRANT SELECT, INSERT, UPDATE ON TABLE "site_credential"
    TO pharmax_app, pharmax_system;

ALTER TABLE "site_credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_credential" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "site_credential"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "site_credential" IS
  'The tenant pharmacy''s own credentials: state licences (resident and non-resident), DEA registration, NPI, NCPDP, NABP. Go-live G-1. Pharmax holds none of these itself; it records and enforces against the customer''s.';

-- ---------------------------------------------------------------------
-- 5. site_authorized_ship_state  (G-2)
-- ---------------------------------------------------------------------

CREATE TABLE "site_authorized_ship_state" (
    "id"             UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId"         UUID NOT NULL,

    "state" VARCHAR(2) NOT NULL,

    -- Required. An authorization with no licence behind it is the
    -- assertion this table exists to stop anyone making.
    "licenseCredentialId" UUID NOT NULL,
    "authorizedByUserId"  UUID NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_authorized_ship_state_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "site_authorized_ship_state"
    ADD CONSTRAINT "site_authorized_ship_state_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_authorized_ship_state"
    ADD CONSTRAINT "site_authorized_ship_state_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_authorized_ship_state"
    ADD CONSTRAINT "site_authorized_ship_state_licenseCredentialId_fkey"
    FOREIGN KEY ("licenseCredentialId") REFERENCES "site_credential"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "site_authorized_ship_state"
    ADD CONSTRAINT "site_authorized_ship_state_authorizedByUserId_fkey"
    FOREIGN KEY ("authorizedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "site_authorized_ship_state_organizationId_siteId_state_key"
    ON "site_authorized_ship_state"("organizationId", "siteId", "state");

ALTER TABLE "site_authorized_ship_state"
    ADD CONSTRAINT "site_authorized_ship_state_state_shape"
    CHECK ("state" ~ '^[A-Z]{2}$');

-- DELETE is granted here, unlike every other table in this migration.
-- The set of states a site ships to is a live configuration an admin
-- narrows as licences lapse, not a historical record — and the audit
-- trail of who changed it lives in audit_log, not in tombstoned rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "site_authorized_ship_state"
    TO pharmax_app, pharmax_system;

ALTER TABLE "site_authorized_ship_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_authorized_ship_state" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "site_authorized_ship_state"
    USING (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('pharmax.system_context', true) = 'on'
        OR "organizationId" = NULLIF(current_setting('pharmax.organization_id', true), '')::uuid
    );

COMMENT ON TABLE "site_authorized_ship_state" IS
  'States a pharmacy site may dispense into. Go-live G-2. Enforcement engages per site: a site with zero rows has asserted nothing and is not enforced against, so the rollout is self-gating rather than a flag someone must remember to flip.';

-- ---------------------------------------------------------------------
-- 6. order.destinationState
--
-- Denormalized from the patient's address at intake so that ship-to-
-- state licensure can be enforced by every ship-committing command,
-- not only the one that happens to receive an address.
--
-- Not backfilled here: deriving the value needs a KMS decrypt per
-- patient, which SQL cannot do.
-- `scripts/operations/backfill-order-destination-state.ts` does that
-- pass. Until it runs, a NULL on a site with enforcement active
-- refuses rather than waves through.
-- ---------------------------------------------------------------------

ALTER TABLE "order" ADD COLUMN "destinationState" VARCHAR(2);

ALTER TABLE "order"
    ADD CONSTRAINT "order_destinationState_shape"
    CHECK ("destinationState" IS NULL OR "destinationState" ~ '^[A-Z]{2}$');

CREATE INDEX "order_organizationId_siteId_destinationState_idx"
    ON "order"("organizationId", "siteId", "destinationState");

COMMENT ON COLUMN "order"."destinationState" IS
  'Two-letter destination state, denormalized from the patient address at intake so ship-to-state licensure is enforceable from every ship command. Plaintext because a state is NOT a HIPAA Safe Harbor identifier (§164.514(b)(2)(i)(B) covers subdivisions smaller than a state). Nothing finer-grained may be denormalized here.';

-- ---------------------------------------------------------------------
-- 7. Migrate provider."deaNumber" into provider_dea_registration.
--
-- Behaviour must not change. The old gate asked only "is a non-blank
-- string present", and granted authority over every schedule. So each
-- migrated row gets:
--
--   * every controlled schedule in authorizedSchedules — narrowing
--     here would silently invalidate live prescribing authority;
--   * NULL expiresAt — not recorded, therefore not blocking;
--   * NULL recordedByUserId — no actor was ever recorded;
--   * registrantType derived from the first letter.
--
-- Rows whose number does not satisfy the shape CHECK are left behind
-- deliberately. The old column's regex allowed `[A-Z]{2}` only, so a
-- value that fails here is one the old regex also rejected — i.e. data
-- that predates validation. Migrating it would put a number the gate
-- cannot reason about behind a credential that looks authoritative.
-- The count is reported by the backfill verification query in the PR.
-- ---------------------------------------------------------------------

INSERT INTO "provider_dea_registration" (
    "id",
    "organizationId",
    "providerId",
    "deaNumber",
    "registrantType",
    "authorizedSchedules",
    "status",
    "verificationMethod",
    "recordedByUserId",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    p."organizationId",
    p."id",
    UPPER(TRIM(p."deaNumber")),
    CASE LEFT(UPPER(TRIM(p."deaNumber")), 1)
        WHEN 'M' THEN 'MID_LEVEL_PRACTITIONER'::"DeaRegistrantType"
        WHEN 'X' THEN 'DATA_WAIVED_LEGACY'::"DeaRegistrantType"
        WHEN 'P' THEN 'NARCOTIC_TREATMENT_PROGRAM'::"DeaRegistrantType"
        WHEN 'R' THEN 'NARCOTIC_TREATMENT_PROGRAM'::"DeaRegistrantType"
        WHEN 'S' THEN 'NARCOTIC_TREATMENT_PROGRAM'::"DeaRegistrantType"
        WHEN 'T' THEN 'NARCOTIC_TREATMENT_PROGRAM'::"DeaRegistrantType"
        WHEN 'U' THEN 'NARCOTIC_TREATMENT_PROGRAM'::"DeaRegistrantType"
        WHEN 'D' THEN 'NON_PRESCRIBING'::"DeaRegistrantType"
        WHEN 'E' THEN 'NON_PRESCRIBING'::"DeaRegistrantType"
        WHEN 'H' THEN 'NON_PRESCRIBING'::"DeaRegistrantType"
        WHEN 'J' THEN 'NON_PRESCRIBING'::"DeaRegistrantType"
        WHEN 'K' THEN 'NON_PRESCRIBING'::"DeaRegistrantType"
        WHEN 'L' THEN 'NON_PRESCRIBING'::"DeaRegistrantType"
        WHEN 'N' THEN 'NON_PRESCRIBING'::"DeaRegistrantType"
        WHEN 'Q' THEN 'NON_PRESCRIBING'::"DeaRegistrantType"
        ELSE 'PRACTITIONER'::"DeaRegistrantType"
    END,
    ARRAY['CII', 'CIII', 'CIV', 'CV']::"ControlledSubstanceSchedule"[],
    'ACTIVE'::"CredentialStatus",
    'ATTESTED'::"CredentialVerificationMethod",
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "provider" p
WHERE p."deaNumber" IS NOT NULL
  AND TRIM(p."deaNumber") <> ''
  AND UPPER(TRIM(p."deaNumber")) ~ '^[A-Z][A-Z9][0-9]{7}$'
ON CONFLICT ("organizationId", "deaNumber") DO NOTHING;

-- ---------------------------------------------------------------------
-- 8. Drop the superseded column.
--
-- Dropped rather than kept alongside: two sources of truth for a
-- controlled-substance gate is the ambiguity that produces a safety
-- failure, and a column no command writes rots into a stale answer
-- someone eventually trusts.
--
-- Nothing queries by DEA number, so the index goes with it.
-- ---------------------------------------------------------------------

DROP INDEX IF EXISTS "provider_organizationId_deaNumber_idx";
ALTER TABLE "provider" DROP COLUMN "deaNumber";
