-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ClinicStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TeamStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BucketKind" AS ENUM ('WORKFLOW', 'EMERGENCY', 'HOLD', 'EXCEPTION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "WorkstationStatus" AS ENUM ('ACTIVE', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('ORGANIZATION', 'SITE', 'CLINIC', 'TEAM');

-- CreateEnum
CREATE TYPE "WorkflowPolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "StripeWebhookEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('DISPENSE_FEE', 'PRODUCT', 'SHIPPING_FEE', 'RUSH_FEE', 'DISCOUNT', 'CREDIT', 'ADJUSTMENT', 'TAX');

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_site" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" "SiteStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pharmacy_site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ClinicStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_site" (
    "id" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinic_site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TeamStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bucket" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID,
    "clinicId" UUID,
    "teamId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "BucketKind" NOT NULL DEFAULT 'WORKFLOW',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workstation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deviceFingerprint" TEXT,
    "status" "WorkstationStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workstation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "hashedPassword" TEXT,
    "mfaEnrolled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "RoleScope" NOT NULL DEFAULT 'ORGANIZATION',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "id" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID,
    "clinicId" UUID,
    "teamId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_policy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "WorkflowPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "definition" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "command_log" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "commandName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "workflowPolicyId" UUID,
    "actorUserId" UUID,
    "workstationId" UUID,
    "requestPayload" JSONB NOT NULL,
    "responsePayload" JSONB,
    "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "targetOrderId" UUID,

    CONSTRAINT "command_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_event" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "actorUserId" UUID,
    "sourceCommandLogId" UUID,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actorUserId" UUID,
    "actorIp" TEXT,
    "actorUserAgent" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "scope" JSONB,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_outbox" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "commandName" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responsePayload" JSONB,
    "responseStatus" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_customer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stripe_customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_webhook_event" (
    "id" UUID NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "apiVersion" TEXT,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "status" "StripeWebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureVerifiedAt" TIMESTAMP(3) NOT NULL,
    "processingStartedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),

    CONSTRAINT "stripe_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "stripeInvoiceId" TEXT,
    "stripeCustomerId" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
    "amountDueCents" INTEGER NOT NULL DEFAULT 0,
    "billingPeriodStart" TIMESTAMP(3),
    "billingPeriodEnd" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "orderId" UUID,
    "kind" "InvoiceLineKind" NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "unitAmountCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "metadata" JSONB,
    "billingEventKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE INDEX "pharmacy_site_organizationId_status_idx" ON "pharmacy_site"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_site_organizationId_code_key" ON "pharmacy_site"("organizationId", "code");

-- CreateIndex
CREATE INDEX "clinic_organizationId_status_idx" ON "clinic"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_organizationId_code_key" ON "clinic"("organizationId", "code");

-- CreateIndex
CREATE INDEX "clinic_site_siteId_idx" ON "clinic_site"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_site_clinicId_siteId_key" ON "clinic_site"("clinicId", "siteId");

-- CreateIndex
CREATE INDEX "team_organizationId_status_idx" ON "team"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "team_siteId_code_key" ON "team"("siteId", "code");

-- CreateIndex
CREATE INDEX "bucket_organizationId_kind_idx" ON "bucket"("organizationId", "kind");

-- CreateIndex
CREATE INDEX "bucket_siteId_sortOrder_idx" ON "bucket"("siteId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "bucket_organizationId_code_key" ON "bucket"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "workstation_deviceFingerprint_key" ON "workstation"("deviceFingerprint");

-- CreateIndex
CREATE INDEX "workstation_organizationId_status_idx" ON "workstation"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workstation_siteId_code_key" ON "workstation"("siteId", "code");

-- CreateIndex
CREATE INDEX "user_organizationId_status_idx" ON "user"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "user_organizationId_email_key" ON "user"("organizationId", "email");

-- CreateIndex
CREATE INDEX "role_organizationId_scope_idx" ON "role"("organizationId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "role_organizationId_code_key" ON "role"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "permission_code_key" ON "permission"("code");

-- CreateIndex
CREATE INDEX "role_permission_permissionId_idx" ON "role_permission"("permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_roleId_permissionId_key" ON "role_permission"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "user_role_organizationId_userId_idx" ON "user_role"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "user_role_roleId_idx" ON "user_role"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_userId_roleId_siteId_clinicId_teamId_key" ON "user_role"("userId", "roleId", "siteId", "clinicId", "teamId");

-- CreateIndex
CREATE INDEX "workflow_policy_organizationId_status_idx" ON "workflow_policy"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_policy_organizationId_code_version_key" ON "workflow_policy"("organizationId", "code", "version");

-- CreateIndex
CREATE INDEX "command_log_organizationId_status_idx" ON "command_log"("organizationId", "status");

-- CreateIndex
CREATE INDEX "command_log_organizationId_commandName_startedAt_idx" ON "command_log"("organizationId", "commandName", "startedAt");

-- CreateIndex
CREATE INDEX "command_log_targetOrderId_idx" ON "command_log"("targetOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "command_log_organizationId_commandName_idempotencyKey_key" ON "command_log"("organizationId", "commandName", "idempotencyKey");

-- CreateIndex
CREATE INDEX "order_event_organizationId_occurredAt_idx" ON "order_event"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "order_event_eventType_occurredAt_idx" ON "order_event"("eventType", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "order_event_orderId_sequenceNumber_key" ON "order_event"("orderId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "audit_log_organizationId_occurredAt_idx" ON "audit_log"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_organizationId_action_occurredAt_idx" ON "audit_log"("organizationId", "action", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_resourceType_resourceId_idx" ON "audit_log"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "event_outbox_status_nextAttemptAt_idx" ON "event_outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "event_outbox_organizationId_eventType_createdAt_idx" ON "event_outbox"("organizationId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "event_outbox_aggregateType_aggregateId_idx" ON "event_outbox"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "idempotency_key_expiresAt_idx" ON "idempotency_key"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_organizationId_commandName_key_key" ON "idempotency_key"("organizationId", "commandName", "key");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_customer_clinicId_key" ON "stripe_customer"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_customer_stripeCustomerId_key" ON "stripe_customer"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "stripe_customer_organizationId_idx" ON "stripe_customer"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_webhook_event_stripeEventId_key" ON "stripe_webhook_event"("stripeEventId");

-- CreateIndex
CREATE INDEX "stripe_webhook_event_status_nextAttemptAt_idx" ON "stripe_webhook_event"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "stripe_webhook_event_eventType_receivedAt_idx" ON "stripe_webhook_event"("eventType", "receivedAt");

-- CreateIndex
CREATE INDEX "stripe_webhook_event_receivedAt_idx" ON "stripe_webhook_event"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_stripeInvoiceId_key" ON "invoice"("stripeInvoiceId");

-- CreateIndex
CREATE INDEX "invoice_organizationId_clinicId_status_idx" ON "invoice"("organizationId", "clinicId", "status");

-- CreateIndex
CREATE INDEX "invoice_status_dueAt_idx" ON "invoice"("status", "dueAt");

-- CreateIndex
CREATE INDEX "invoice_stripeCustomerId_idx" ON "invoice"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_organizationId_invoiceNumber_key" ON "invoice"("organizationId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_billingEventKey_key" ON "invoice_line"("billingEventKey");

-- CreateIndex
CREATE INDEX "invoice_line_invoiceId_idx" ON "invoice_line"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_line_organizationId_clinicId_idx" ON "invoice_line"("organizationId", "clinicId");

-- CreateIndex
CREATE INDEX "invoice_line_orderId_idx" ON "invoice_line"("orderId");

-- AddForeignKey
ALTER TABLE "pharmacy_site" ADD CONSTRAINT "pharmacy_site_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic" ADD CONSTRAINT "clinic_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_site" ADD CONSTRAINT "clinic_site_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_site" ADD CONSTRAINT "clinic_site_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team" ADD CONSTRAINT "team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team" ADD CONSTRAINT "team_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bucket" ADD CONSTRAINT "bucket_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bucket" ADD CONSTRAINT "bucket_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bucket" ADD CONSTRAINT "bucket_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bucket" ADD CONSTRAINT "bucket_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation" ADD CONSTRAINT "workstation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation" ADD CONSTRAINT "workstation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "pharmacy_site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_policy" ADD CONSTRAINT "workflow_policy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_log" ADD CONSTRAINT "command_log_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_log" ADD CONSTRAINT "command_log_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_sourceCommandLogId_fkey" FOREIGN KEY ("sourceCommandLogId") REFERENCES "command_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stripe_customer" ADD CONSTRAINT "stripe_customer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stripe_customer" ADD CONSTRAINT "stripe_customer_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

