// Public surface of @pharmax/database.
//
// Other packages MUST import the Prisma client and types from here, not
// from `@prisma/client` or the generated path directly. This keeps the
// generator location an implementation detail and lets us swap clients
// (e.g. for an Accelerate / Data Proxy variant) without rippling
// imports across the monorepo.

// The canonical, tenancy-enforced client. Application code imports
// THIS. Tenant-scoped models are auto-filtered to the active
// `withTenancyContext` org and fail closed with no frame.
export { prisma } from "./scoped-client.js";
// The raw, UNSCOPED client. Cross-tenant system/bootstrap code only.
export { systemPrisma } from "./client.js";
// Both-layers (ORM extension + RLS GUC) tenant-scoped read wrapper.
export { readInTenantContext, type TenantTransactionClient } from "./scoped-read.js";
export * as billing from "./billing/index.js";
export * as phi from "./phi/index.js";
export {
  Prisma,
  PrismaClient,
  // Enums (re-exported for ergonomic value-side usage in commands/seeds)
  BucketKind,
  CancellationDisposition,
  CarrierCredentialStatus,
  ClerkWebhookEventStatus,
  ClinicStatus,
  CommandStatus,
  EasyPostWebhookEventStatus,
  HoldReason,
  HoldReleaseReason,
  OrderStageIntervalKind,
  IntakeSourceKind,
  InventoryTransactionReason,
  InvoiceLineKind,
  InvoiceStatus,
  LabelPrinterConnection,
  LabelPrinterProtocol,
  LabelPrinterStatus,
  LabelPrinterVendor,
  LabelStockKind,
  LotStatus,
  NotificationDeliveryStatus,
  ResendWebhookEventStatus,
  OrderLineStatus,
  OrderPriority,
  OrderStatus,
  OrganizationStatus,
  OutboxStatus,
  PackagePhotoMatchStrategy,
  PackagePhotoTrackingSource,
  PatientStatus,
  PrescriptionStatus,
  PricingRuleStatus,
  PrintJobStatus,
  ProviderStatus,
  ReopenReason,
  ReportScheduleNotifyOn,
  ReportScheduleRunStatus,
  ReportScheduleStatus,
  RoleScope,
  ShipmentCarrier,
  ShipmentStatus,
  ShipmentTrackingEventKind,
  ShipmentTrackingSource,
  ShippingProvider,
  SiteStatus,
  StripeWebhookEventStatus,
  TeamStatus,
  UserStatus,
  VerificationDecision,
  VerificationStage,
  WorkflowPolicyOverlayStatus,
  WorkflowPolicyStatus,
  WorkstationStatus,
} from "./generated/client/index.js";

// Row types (re-exported so consumers depend on @pharmax/database, not
// on @prisma/client or the generated client path directly). Add new
// models here as the schema grows; missing exports surface as TS2305
// errors at the consumption site.
export type {
  AuditChainState,
  AuditLog,
  Bucket,
  Clinic,
  ClinicSite,
  CommandLog,
  EventOutbox,
  IdempotencyKey,
  InventoryTransaction,
  Invoice,
  InvoiceLine,
  LabelPrinter,
  Lot,
  LotAssignment,
  Order,
  OrderCancellation,
  OrderCorrectionReopen,
  OrderEvent,
  OrderHold,
  OrderLine,
  OrderStageInterval,
  Organization,
  Patient,
  PharmacySite,
  Permission,
  Prescription,
  PrintJob,
  PrintTemplate,
  Product,
  Provider,
  ReportRun,
  ReportSchedule,
  NotificationDelivery,
  ResendWebhookEvent,
  Role,
  RolePermission,
  CarrierCredential,
  ClerkWebhookEvent,
  EasyPostWebhookEvent,
  Shipment,
  ShipmentTrackingEvent,
  StripeCustomer,
  StripeWebhookEvent,
  Team,
  User,
  UserRole,
  VialLabel,
  VerificationRecord,
  WorkflowPolicy,
  Workstation,
} from "./generated/client/index.js";
