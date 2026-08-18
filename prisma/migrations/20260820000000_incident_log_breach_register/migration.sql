-- ---------------------------------------------------------------------
-- Incident log / breach register — schema.prisma §11
--
-- HIPAA 45 CFR §164.408 (annual submission of sub-500 breaches),
-- §164.414 (burden of proof), and SOC 2 CC7.3 / CC7.4 (incident
-- response evidence).
--
-- One table, not two. A breach is a SUBSET of incidents rather than a
-- parallel universe of them, so the breach-determination columns are
-- nullable and populated only when PHI was involved. Two tables would
-- have to be kept in sync, and the failure mode of that — an incident
-- recorded without its determination, or a determination with no
-- incident — is precisely the gap §164.414 asks us to close.
--
-- This replaces the stub behaviour in scripts/soc2/export-incident-log.ts,
-- which until now emitted `incident-log-stub.txt` plus a best-effort
-- audit_log proxy because no structured log existed.
--
-- PHI INVARIANT: this table holds NO PHI. Counts, coded categories,
-- state distributions and references only — never names, addresses,
-- dates of birth, or any patient identifier. The identified material
-- (notice copies, the affected-individual list) lives in the §164.414
-- evidence file behind `evidence_path`, which is classified Restricted
-- and controlled separately. See Breach Notification Policy §8–§9.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. Enums.
-- ---------------------------------------------------------------------

CREATE TYPE "IncidentSeverity" AS ENUM ('SEV0', 'SEV1', 'SEV2', 'SEV3');

CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'CONTAINED', 'RESOLVED', 'CLOSED');

-- Which hat Pharmax wore. Drives which obligations attach: a business
-- associate owes §164.410 to the covered entity; a covered entity owes
-- §164.404 / §164.406 / §164.408 directly.
CREATE TYPE "BreachRole" AS ENUM ('BUSINESS_ASSOCIATE', 'COVERED_ENTITY');

-- Outcome of the §164.402(2) four-factor risk assessment.
--
-- PENDING is deliberately distinct from the NOT_BREACH_* values and is
-- the default. An impermissible disclosure of unsecured PHI is PRESUMED
-- to be a breach until the assessment demonstrates otherwise, so an
-- undetermined row carries live notification obligations rather than
-- resting in a neutral state.
CREATE TYPE "BreachDetermination" AS ENUM (
    'PENDING',
    'BREACH',
    'NOT_BREACH_LOW_PROBABILITY',
    'NOT_BREACH_EXCEPTION',
    'NOT_BREACH_SECURED_PHI'
);

-- ---------------------------------------------------------------------
-- 2. Table.
-- ---------------------------------------------------------------------

CREATE TABLE "incident_log" (
    -- No DB-side default: Prisma's @default(uuid()) generates the value
    -- client-side, matching every other table in this schema.
    "id"                        UUID                  NOT NULL,
    "incidentRef"               TEXT                  NOT NULL,

    -- Soft reference. Intentionally NOT a foreign key, matching
    -- compliance_check_run: an organization that offboards after a
    -- breach does not get to take the evidence of that breach with it,
    -- and §164.414 puts the burden of proof on us for six years.
    "subjectOrganizationId"     UUID,

    "severity"                  "IncidentSeverity"    NOT NULL,
    "status"                    "IncidentStatus"      NOT NULL DEFAULT 'OPEN',
    "title"                     TEXT                  NOT NULL,

    "detectedAt"                TIMESTAMP(3)          NOT NULL,

    -- HIPAA discovery: the first day the incident was known, or by
    -- reasonable diligence would have been known, to any workforce
    -- member other than whoever caused it. Frequently EARLIER than
    -- detectedAt, and every statutory deadline runs from here — which
    -- is why it is a separate column rather than an alias.
    "discoveredAt"              TIMESTAMP(3)          NOT NULL,
    "discoveredBy"              TEXT                  NOT NULL,

    "containedAt"               TIMESTAMP(3),
    "resolvedAt"                TIMESTAMP(3),

    "phiInvolved"               BOOLEAN               NOT NULL DEFAULT false,
    "determination"             "BreachDetermination" NOT NULL DEFAULT 'PENDING',
    "breachRole"                "BreachRole",
    "determinationBasis"        TEXT,
    "exceptionRelied"           TEXT,

    "affectedIndividualCount"   INTEGER,

    -- Counts by state of residence, e.g. {"CA": 520, "TX": 300}.
    -- COUNTS ONLY. §164.406 turns on more than 500 residents of a
    -- SINGLE state rather than 500 in aggregate, so the distribution is
    -- the fact that decides it; an aggregate total cannot answer the
    -- question.
    "stateDistribution"         JSONB,

    "phiCategories"             TEXT[]                NOT NULL DEFAULT ARRAY[]::TEXT[],
    "notifications"             JSONB,

    -- Whether this row has been included in the §164.408 annual
    -- submission. Explicit rather than derived: "did we file it?" is a
    -- fact about an action taken, not something inferable from dates.
    "hhsAnnualLogSubmittedAt"   TIMESTAMP(3),

    "evidencePath"              TEXT,
    "determinedAt"              TIMESTAMP(3),
    "determinedByUserId"        UUID,
    "approvedByUserId"          UUID,

    "createdAt"                 TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                 TIMESTAMP(3)          NOT NULL,

    CONSTRAINT "incident_log_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. Indexes.
--
-- The §164.408 annual filing is "every sub-500 breach discovered in
-- calendar year N", so discovery date plus determination is the access
-- path for the one query this table must always be able to answer.
-- ---------------------------------------------------------------------

CREATE UNIQUE INDEX "incident_log_incidentRef_key"
    ON "incident_log" ("incidentRef");

CREATE INDEX "incident_log_discoveredAt_idx"
    ON "incident_log" ("discoveredAt");

CREATE INDEX "incident_log_determination_discoveredAt_idx"
    ON "incident_log" ("determination", "discoveredAt");

CREATE INDEX "incident_log_subjectOrganizationId_discoveredAt_idx"
    ON "incident_log" ("subjectOrganizationId", "discoveredAt");

-- ---------------------------------------------------------------------
-- 4. Grants.
--
-- No RLS. Registered in prisma/migrations/rls-exempt.txt with the
-- reasoning: the record belongs to Pharmax-the-operator rather than to
-- any tenant, an incident can span several tenants or none, the annual
-- filing is platform-wide by definition, and the table holds no PHI —
-- so the read boundary RLS would provide is protecting nothing.
--
-- UPDATE is granted, unlike compliance_check_run. A check run is a
-- point-in-time observation and is immutable by nature; an incident is
-- a record that legitimately evolves — contained, then resolved, then
-- determined, then notified, then filed. Forbidding UPDATE would force
-- either a row per state transition or an out-of-band edit, and both
-- are worse for the §164.414 burden than an auditable mutable row.
--
-- DELETE is granted to NEITHER role. A breach determination that can be
-- deleted is a burden of proof that cannot be discharged.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON TABLE "incident_log"
    TO pharmax_app, pharmax_system;
