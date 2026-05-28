// Public surface of @pharmax/events.
//
// What lives here:
//
//   - The factory and types (defineEvent, EventDefinition, EventOwner,
//     EventRetention).
//   - The shared registry (EVENT_REGISTRY, getEventDefinition,
//     listRegisteredEventNames, listRegisteredEventDefinitions).
//   - Validation helpers (validateEventPayload, validateAgainst).
//   - The compatibility checker (assertEventCompatibility,
//     diffEventSchemas, CompatibilityKind, SchemaDifference).
//   - The typed/legacy emit helper.
//   - The parity-guard scanner + allowlist (used by both the test
//     in this package and the validate-registry / migrate-allowlist
//     CLI scripts under `scripts/events/`).
//   - One re-export of every domain barrel, so consumers can
//     `import { OrderShippedV1 } from "@pharmax/events"` without
//     digging into the per-domain folders. The per-domain barrels
//     are also re-exported under `./events/index.js` for callers
//     that want to opt into per-domain shape (e.g. a BI ingestion
//     service that fans events out by domain prefix).
//
// Versioning surface:
//   When a v2 lands, both `OrderShippedV1` AND `OrderShippedV2`
//   should be exported until consumers cut over. The registry
//   carries both entries keyed on `order.shipped.v1` and
//   `order.shipped.v2` so producers can pick the active version
//   per call site.

export {
  defineEvent,
  validateAgainst,
  isZodObject,
  isFieldOptional,
  getZodTypeName,
  EVENT_NAME_REGEX,
  type EventDefinition,
  type DefineEventSpec,
  type EventOwner,
  type EventRetention,
  type OutboxEventDraft,
  type ValidationResult,
} from "./define-event.js";

export {
  EVENT_REGISTRY,
  getEventDefinition,
  listRegisteredEventNames,
  listRegisteredEventDefinitions,
} from "./registry.js";

export { emit, EVENT_PAYLOAD_INVALID, type LegacyEmitOptions } from "./emit.js";

export {
  assertEventCompatibility,
  diffEventSchemas,
  type CompatibilityKind,
  type CompatibilityResult,
  type SchemaDifference,
} from "./compatibility.js";

export {
  scanRepositoryForEventNames,
  extractEventNameLiterals,
  buildParityReport,
  EVENT_REGISTRATION_ALLOWLIST,
  EVENT_NAME_LITERAL,
  type ScanResult,
  type ParityReport,
  type EventLiteralOccurrence,
} from "./parity-guard.js";

// ----------- Domain barrels -----------
//
// Every per-domain definition is re-exported here so the top-level
// `@pharmax/events` import surface stays one-stop. The per-domain
// barrels in `./events/<domain>/index.js` are the layer at which
// new events register; this file just forwards.

export * from "./events/index.js";

// Re-export payload type aliases. These are deliberately listed
// explicitly (vs. an `export type * from "./events/index.js"`) so
// a `git grep` for a payload type name resolves to this file.
export type { OrganizationCreatedV1Payload } from "./events/organization/created-v1.js";

export type { OrgBucketsProvisionedV1Payload } from "./events/org/buckets-provisioned-v1.js";
export type { OrgSiteAddressUpdatedV1Payload } from "./events/org/site-address-updated-v1.js";
export type { OrgUserInvitedV1Payload } from "./events/org/user-invited-v1.js";
export type { OrgUserRoleGrantedV1Payload } from "./events/org/user-role-granted-v1.js";
export type { OrgUserRoleRevokedV1Payload } from "./events/org/user-role-revoked-v1.js";

export type { PatientRegisteredV1Payload } from "./events/patient/registered-v1.js";
export type { PatientUpdatedV1Payload } from "./events/patient/updated-v1.js";
export type { PatientCryptoShreddedV1Payload } from "./events/patient/crypto-shredded-v1.js";
export type { PatientViewedV1Payload } from "./events/patient/viewed-v1.js";

export type { ProviderDeactivatedV1Payload } from "./events/provider/deactivated-v1.js";
export type { ProviderReactivatedV1Payload } from "./events/provider/reactivated-v1.js";
export type { ProviderRegisteredV1Payload } from "./events/provider/registered-v1.js";
export type { ProviderUpdatedV1Payload } from "./events/provider/updated-v1.js";

export type { OrderReceivedV1Payload } from "./events/order/received-v1.js";
export type { OrderTypingStartedV1Payload } from "./events/order/typing-started-v1.js";
export type { OrderTypingCompletedV1Payload } from "./events/order/typing-completed-v1.js";
export type { OrderPv1StartedV1Payload } from "./events/order/pv1-started-v1.js";
export type { OrderPv1ApprovedV1Payload } from "./events/order/pv1-approved-v1.js";
export type { OrderPv1RejectedV1Payload } from "./events/order/pv1-rejected-v1.js";
export type { OrderFillStartedV1Payload } from "./events/order/fill-started-v1.js";
export type { OrderFillCompletedV1Payload } from "./events/order/fill-completed-v1.js";
export type { OrderFinalStartedV1Payload } from "./events/order/final-started-v1.js";
export type { OrderFinalApprovedV1Payload } from "./events/order/final-approved-v1.js";
export type { OrderFinalRejectedV1Payload } from "./events/order/final-rejected-v1.js";
export type { OrderShipReleasedV1Payload } from "./events/order/ship-released-v1.js";
export type { OrderShippedV1Payload } from "./events/order/shipped-v1.js";
export type { OrderCancelledV1Payload } from "./events/order/cancelled-v1.js";
export type { OrderHeldV1Payload } from "./events/order/held-v1.js";
export type { OrderHoldReleasedV1Payload } from "./events/order/hold-released-v1.js";
export type { OrderReopenedV1Payload } from "./events/order/reopened-v1.js";
export type { OrderPrescriptionAddedV1Payload } from "./events/order/prescription-added-v1.js";
export type { OrderEscalatedToEmergencyV1Payload } from "./events/order/escalated-to-emergency-v1.js";
export type { OrderEscalationAcknowledgedV1Payload } from "./events/order/escalation-acknowledged-v1.js";
export type { OrderEscalationResolvedV1Payload } from "./events/order/escalation-resolved-v1.js";
export type { OrderShipmentCreatedV1Payload } from "./events/order/shipment-created-v1.js";
export type { OrderShipmentLabelPurchasedV1Payload } from "./events/order/shipment-label-purchased-v1.js";
export type { OrderShipmentEscalationReaffirmedV1Payload } from "./events/order/shipment-escalation-reaffirmed-v1.js";

export type { ShipmentTrackingRecordedV1Payload } from "./events/shipment/tracking-recorded-v1.js";
export type { ShippingCarrierCredentialRegisteredV1Payload } from "./events/shipping/carrier-credential-registered-v1.js";
export type { ShippingPackagePhotoCapturedV1Payload } from "./events/shipping/package-photo-captured-v1.js";
export type { ShippingPackagePhotoMatchResolvedV1Payload } from "./events/shipping/package-photo-match-resolved-v1.js";

export type { FillLotAssignedV1Payload } from "./events/fill/lot-assigned-v1.js";

export type { LabelsVialPrintRequestedV1Payload } from "./events/labels/vial-print-requested-v1.js";
export type { LabelsVialPrintReprintRequestedV1Payload } from "./events/labels/vial-print-reprint-requested-v1.js";
export type { LabelsVialPrintCompletedV1Payload } from "./events/labels/vial-print-completed-v1.js";
export type { LabelsVialPrintFailedV1Payload } from "./events/labels/vial-print-failed-v1.js";

export type { BillingInvoiceLineCreatedV1Payload } from "./events/billing/invoice-line-created-v1.js";
export type { BillingInvoiceFinalizedV1Payload } from "./events/billing/invoice-finalized-v1.js";
export type { BillingInvoiceStripePushedV1Payload } from "./events/billing/invoice-stripe-pushed-v1.js";
export type { BillingInvoicePaidV1Payload } from "./events/billing/invoice-paid-v1.js";
export type { BillingInvoicePaymentFailedV1Payload } from "./events/billing/invoice-payment-failed-v1.js";
export type { BillingInvoiceRefundedV1Payload } from "./events/billing/invoice-refunded-v1.js";
export type { BillingInvoiceCreditedV1Payload } from "./events/billing/invoice-credited-v1.js";
export type { BillingInvoiceUncollectibleV1Payload } from "./events/billing/invoice-uncollectible-v1.js";
export type { BillingInvoiceVoidedV1Payload } from "./events/billing/invoice-voided-v1.js";
export type { BillingPricingRuleUpsertedV1Payload } from "./events/billing/pricing-rule-upserted-v1.js";

export type { WorkflowOverlayUpsertedV1Payload } from "./events/workflow/overlay-upserted-v1.js";
