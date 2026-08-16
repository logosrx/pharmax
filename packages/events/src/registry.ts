// EVENT_REGISTRY — the single source of truth for event vocabulary.
//
// Build pattern:
//
//   Every definition is exported from a sibling file under
//   `./events/<domain>/<name>-v<n>.ts`. This file imports each
//   one explicitly and freezes them into a `ReadonlyMap` keyed by
//   `EventDefinition.fullName`. Side-effect-free registration
//   means import order is irrelevant; the map is materialized
//   exactly once when this module loads.
//
// Why explicit imports vs. a glob:
//
//   - Glob registration ("import every *.ts under events/") hides
//     the dependency graph from the type checker. A typo in a file
//     name silently drops an event from the registry, and the
//     parity guard would catch it after-the-fact, in CI, after a
//     misnamed event already shipped.
//   - Explicit imports give us a compile-time guarantee: if a
//     definition file is renamed without updating this file, the
//     build fails immediately.
//
// PHI rule: nothing in this file reads PHI. The registry is
// vocabulary metadata.

import { type EventDefinition, EVENT_NAME_REGEX } from "./define-event.js";

// ---- billing -------------------------------------------------------------
import { BillingClinicCreditRecordedV1 } from "./events/billing/clinic-credit-recorded-v1.js";
import { BillingInvoiceApprovedV1 } from "./events/billing/invoice-approved-v1.js";
import { BillingInvoiceCreditedV1 } from "./events/billing/invoice-credited-v1.js";
import { BillingInvoiceFinalizedV1 } from "./events/billing/invoice-finalized-v1.js";
import { BillingInvoiceLineCreatedV1 } from "./events/billing/invoice-line-created-v1.js";
import { BillingInvoicePaidV1 } from "./events/billing/invoice-paid-v1.js";
import { BillingInvoicePaymentFailedV1 } from "./events/billing/invoice-payment-failed-v1.js";
import { BillingInvoiceRefundedV1 } from "./events/billing/invoice-refunded-v1.js";
import { BillingInvoiceStripePushedV1 } from "./events/billing/invoice-stripe-pushed-v1.js";
import { BillingInvoiceUncollectibleV1 } from "./events/billing/invoice-uncollectible-v1.js";
import { BillingInvoiceVoidedV1 } from "./events/billing/invoice-voided-v1.js";
import { BillingPaymentRecordedV1 } from "./events/billing/payment-recorded-v1.js";
import { BillingPricingRuleUpsertedV1 } from "./events/billing/pricing-rule-upserted-v1.js";

// ---- catalog (compound product definitions) ------------------------------
import { CatalogCompoundProductCreatedV1 } from "./events/catalog/compound-product-created-v1.js";

// ---- compliance (SOC 2 / HIPAA evidence) --------------------------------
import { ComplianceAccessReviewSnapshotRecordedV1 } from "./events/compliance/access-review-snapshot-recorded-v1.js";
import { ComplianceCheckExceptionAcceptedV1 } from "./events/compliance/check-exception-accepted-v1.js";
import { ComplianceControlSignedOffV1 } from "./events/compliance/control-signed-off-v1.js";

// ---- compounding (ADR-0035) ----------------------------------------------
import { CompoundingFormulaCreatedV1 } from "./events/compounding/formula-created-v1.js";
import { CompoundingFormulaPublishedV1 } from "./events/compounding/formula-published-v1.js";
import { CompoundingFormulaRetiredV1 } from "./events/compounding/formula-retired-v1.js";
import { CompoundingPreparationRecordedV1 } from "./events/compounding/preparation-recorded-v1.js";
import { InventoryLotReceivedV1 } from "./events/inventory/lot-received-v1.js";
import { InventoryProductAiGuardrailSetV1 } from "./events/inventory/product-ai-guardrail-set-v1.js";
import { InventoryProductCreatedV1 } from "./events/inventory/product-created-v1.js";
import { InventoryProductUpdatedV1 } from "./events/inventory/product-updated-v1.js";

// ---- fill ----------------------------------------------------------------
import { FillLotAssignedV1 } from "./events/fill/lot-assigned-v1.js";

// ---- labels --------------------------------------------------------------
import { LabelsVialPrintCompletedV1 } from "./events/labels/vial-print-completed-v1.js";
import { LabelsVialPrintFailedV1 } from "./events/labels/vial-print-failed-v1.js";
import { LabelsVialPrintReprintRequestedV1 } from "./events/labels/vial-print-reprint-requested-v1.js";
import { LabelsVialPrintRequestedV1 } from "./events/labels/vial-print-requested-v1.js";

// ---- order ---------------------------------------------------------------
import { OrderCancelledV1 } from "./events/order/cancelled-v1.js";
import { OrderEscalatedToEmergencyV1 } from "./events/order/escalated-to-emergency-v1.js";
import { OrderEscalationAcknowledgedV1 } from "./events/order/escalation-acknowledged-v1.js";
import { OrderEscalationResolvedV1 } from "./events/order/escalation-resolved-v1.js";
import { OrderFillCompletedV1 } from "./events/order/fill-completed-v1.js";
import { OrderFillStartedV1 } from "./events/order/fill-started-v1.js";
import { OrderFinalApprovedV1 } from "./events/order/final-approved-v1.js";
import { OrderFinalRejectedV1 } from "./events/order/final-rejected-v1.js";
import { OrderFinalStartedV1 } from "./events/order/final-started-v1.js";
import { OrderHeldV1 } from "./events/order/held-v1.js";
import { OrderHoldReleasedV1 } from "./events/order/hold-released-v1.js";
import { OrderPrescriptionAddedV1 } from "./events/order/prescription-added-v1.js";
import { OrderPv1ApprovalRefusedV1 } from "./events/order/pv1-approval-refused-v1.js";
import { OrderPv1ApprovedV1 } from "./events/order/pv1-approved-v1.js";
import { OrderPv1RejectedV1 } from "./events/order/pv1-rejected-v1.js";
import { OrderPv1ScreeningAcknowledgedForPatientV1 } from "./events/order/pv1-screening-acknowledged-for-patient-v1.js";
import { OrderPv1ScreeningAcknowledgedV1 } from "./events/order/pv1-screening-acknowledged-v1.js";
import { OrderPv1ScreeningRecordedV1 } from "./events/order/pv1-screening-recorded-v1.js";
import { OrderPv1StartedV1 } from "./events/order/pv1-started-v1.js";
import { OrderReceivedV1 } from "./events/order/received-v1.js";
import { OrderReopenedV1 } from "./events/order/reopened-v1.js";
import { OrderShipReleasedV1 } from "./events/order/ship-released-v1.js";
import { OrderShipmentCreatedV1 } from "./events/order/shipment-created-v1.js";
import { OrderShipmentEscalationReaffirmedV1 } from "./events/order/shipment-escalation-reaffirmed-v1.js";
import { OrderShipmentLabelPurchasedV1 } from "./events/order/shipment-label-purchased-v1.js";
import { OrderShippedV1 } from "./events/order/shipped-v1.js";
import { OrderSlaBreachEscalatedV1 } from "./events/order/sla-breach-escalated-v1.js";
import { OrderSlaBreachEscalationReaffirmedV1 } from "./events/order/sla-breach-escalation-reaffirmed-v1.js";
import { OrderTypingCompletedV1 } from "./events/order/typing-completed-v1.js";
import { OrderTypingMissingInfoV1 } from "./events/order/typing-missing-info-v1.js";
import { OrderTypingResumedV1 } from "./events/order/typing-resumed-v1.js";
import { OrderTypingStartedV1 } from "./events/order/typing-started-v1.js";

// ---- org (tenant administration) ----------------------------------------
import { AiAssistPolicySetV1 } from "./events/org/ai-assist-policy-set-v1.js";
import { OrgBucketCreatedV1 } from "./events/org/bucket-created-v1.js";
import { OrgBucketDeletedV1 } from "./events/org/bucket-deleted-v1.js";
import { OrgBucketUpdatedV1 } from "./events/org/bucket-updated-v1.js";
import { OrgBucketsProvisionedV1 } from "./events/org/buckets-provisioned-v1.js";
import { OrgRoleCreatedV1 } from "./events/org/role-created-v1.js";
import { OrgRolePermissionsUpdatedV1 } from "./events/org/role-permissions-updated-v1.js";
import { OrgSiteAddressUpdatedV1 } from "./events/org/site-address-updated-v1.js";
import { OrgUserInvitedV1 } from "./events/org/user-invited-v1.js";
import { OrgUserRoleGrantedV1 } from "./events/org/user-role-granted-v1.js";
import { OrgUserRoleRevokedV1 } from "./events/org/user-role-revoked-v1.js";

// ---- organization (tenant lifecycle) ------------------------------------
import { OrganizationCreatedV1 } from "./events/organization/created-v1.js";

// ---- platform (partner API keys + outbound webhooks, ADR-0032) ----------
import { PlatformApiKeyCreatedV1 } from "./events/platform/api-key-created-v1.js";
import { PlatformApiKeyRevokedV1 } from "./events/platform/api-key-revoked-v1.js";
import { PlatformWebhookSubscriptionCreatedV1 } from "./events/platform/webhook-subscription-created-v1.js";
import { PlatformWebhookSubscriptionRevokedV1 } from "./events/platform/webhook-subscription-revoked-v1.js";
import { PlatformWebhookSubscriptionSecretRotatedV1 } from "./events/platform/webhook-subscription-secret-rotated-v1.js";

// ---- patient -------------------------------------------------------------
import { PatientAllergyHistoryAssertedV1 } from "./events/patient/allergy-history-asserted-v1.js";
import { PatientAllergyRecordedV1 } from "./events/patient/allergy-recorded-v1.js";
import { PatientAllergyStatusAmendedV1 } from "./events/patient/allergy-status-amended-v1.js";
import { PatientCryptoShreddedV1 } from "./events/patient/crypto-shredded-v1.js";
import { PatientRegisteredV1 } from "./events/patient/registered-v1.js";
import { PatientUpdatedV1 } from "./events/patient/updated-v1.js";
import { PatientViewedV1 } from "./events/patient/viewed-v1.js";

// ---- prescription --------------------------------------------------------
import { PrescriptionCreatedV1 } from "./events/prescription/created-v1.js";

// ---- provider ------------------------------------------------------------
import { ProviderDeactivatedV1 } from "./events/provider/deactivated-v1.js";
import { ProviderOnboardingApprovedV1 } from "./events/provider/onboarding-approved-v1.js";
import { ProviderOnboardingRejectedV1 } from "./events/provider/onboarding-rejected-v1.js";
import { ProviderOnboardingReviewRequiredV1 } from "./events/provider/onboarding-review-required-v1.js";
import { ProviderOnboardingSubmittedV1 } from "./events/provider/onboarding-submitted-v1.js";
import { ProviderPortalAccountActivatedV1 } from "./events/provider/portal-account-activated-v1.js";
import { ProviderPortalAccountPasswordChangedV1 } from "./events/provider/portal-account-password-changed-v1.js";
import { ProviderPortalAccountProvisionedV1 } from "./events/provider/portal-account-provisioned-v1.js";
import { ProviderPortalAccountSignedInV1 } from "./events/provider/portal-account-signed-in-v1.js";
import { ProviderReactivatedV1 } from "./events/provider/reactivated-v1.js";
import { ProviderRegisteredV1 } from "./events/provider/registered-v1.js";
import { ProviderUpdatedV1 } from "./events/provider/updated-v1.js";

// ---- reporting (on-demand + scheduled report runs) ----------------------
import { ReportingRunCompletedV1 } from "./events/reporting/run-completed-v1.js";
import { ReportScheduleCreatedV1 } from "./events/reporting/schedule-created-v1.js";
import { ReportScheduleDisabledV1 } from "./events/reporting/schedule-disabled-v1.js";
import { ReportScheduleUpdatedV1 } from "./events/reporting/schedule-updated-v1.js";

// ---- shipment (carrier-side tracking) -----------------------------------
import { ShipmentTrackingRecordedV1 } from "./events/shipment/tracking-recorded-v1.js";

// ---- shipping (carrier credentials, dispatch capture) -------------------
import { ShippingCarrierCredentialRegisteredV1 } from "./events/shipping/carrier-credential-registered-v1.js";
import { ShippingPackagePhotoArchivedV1 } from "./events/shipping/package-photo-archived-v1.js";
import { ShippingPackagePhotoCapturedV1 } from "./events/shipping/package-photo-captured-v1.js";
import { ShippingPackagePhotoMatchResolvedV1 } from "./events/shipping/package-photo-match-resolved-v1.js";

// ---- user (phase-6 in-house auth engine) ---------------------------------
import { UserDeactivatedV1 } from "./events/user/deactivated-v1.js";
import { UserInviteAcceptedV1 } from "./events/user/invite-accepted-v1.js";
import { UserInviteIssuedV1 } from "./events/user/invite-issued-v1.js";
import { UserMfaEnrolledV1 } from "./events/user/mfa-enrolled-v1.js";
import { UserMfaEnrollmentStartedV1 } from "./events/user/mfa-enrollment-started-v1.js";
import { UserPasswordChangedV1 } from "./events/user/password-changed-v1.js";
import { UserPasswordResetRequestedV1 } from "./events/user/password-reset-requested-v1.js";
import { UserPasswordResetV1 } from "./events/user/password-reset-v1.js";
import { UserSessionsRevokedV1 } from "./events/user/sessions-revoked-v1.js";
import { UserSignedInV1 } from "./events/user/signed-in-v1.js";
import { UserWebAuthnAuthenticationStartedV1 } from "./events/user/webauthn-authentication-started-v1.js";
import { UserWebAuthnCredentialEnrolledV1 } from "./events/user/webauthn-credential-enrolled-v1.js";
import { UserWebAuthnRegistrationStartedV1 } from "./events/user/webauthn-registration-started-v1.js";

// ---- workflow (per-tenant policy administration) ------------------------
import { WorkflowOverlayUpsertedV1 } from "./events/workflow/overlay-upserted-v1.js";

/**
 * Every definition in the registry. Order is not significant;
 * declared as an array literal so the loop below is the single
 * source of registration logic.
 */
const ALL_DEFINITIONS: ReadonlyArray<EventDefinition<Record<string, unknown>>> = Object.freeze([
  // billing
  BillingClinicCreditRecordedV1,
  BillingInvoiceApprovedV1,
  BillingInvoiceCreditedV1,
  BillingInvoiceFinalizedV1,
  BillingInvoiceLineCreatedV1,
  BillingInvoicePaidV1,
  BillingInvoicePaymentFailedV1,
  BillingInvoiceRefundedV1,
  BillingInvoiceStripePushedV1,
  BillingInvoiceUncollectibleV1,
  BillingInvoiceVoidedV1,
  BillingPaymentRecordedV1,
  BillingPricingRuleUpsertedV1,
  // catalog
  CatalogCompoundProductCreatedV1,
  // compliance
  ComplianceAccessReviewSnapshotRecordedV1,
  ComplianceCheckExceptionAcceptedV1,
  ComplianceControlSignedOffV1,
  // compounding
  CompoundingFormulaCreatedV1,
  CompoundingFormulaPublishedV1,
  CompoundingFormulaRetiredV1,
  CompoundingPreparationRecordedV1,
  InventoryLotReceivedV1,
  InventoryProductAiGuardrailSetV1,
  InventoryProductCreatedV1,
  InventoryProductUpdatedV1,
  // fill
  FillLotAssignedV1,
  // ai typing assist (org policy)
  AiAssistPolicySetV1,
  // labels
  LabelsVialPrintCompletedV1,
  LabelsVialPrintFailedV1,
  LabelsVialPrintReprintRequestedV1,
  LabelsVialPrintRequestedV1,
  // order
  OrderCancelledV1,
  OrderEscalatedToEmergencyV1,
  OrderEscalationAcknowledgedV1,
  OrderEscalationResolvedV1,
  OrderFillCompletedV1,
  OrderFillStartedV1,
  OrderFinalApprovedV1,
  OrderFinalRejectedV1,
  OrderFinalStartedV1,
  OrderHeldV1,
  OrderHoldReleasedV1,
  OrderPrescriptionAddedV1,
  OrderPv1ApprovalRefusedV1,
  OrderPv1ApprovedV1,
  OrderPv1RejectedV1,
  OrderPv1ScreeningAcknowledgedForPatientV1,
  OrderPv1ScreeningAcknowledgedV1,
  OrderPv1ScreeningRecordedV1,
  OrderPv1StartedV1,
  OrderReceivedV1,
  OrderReopenedV1,
  OrderShipReleasedV1,
  OrderShipmentCreatedV1,
  OrderShipmentEscalationReaffirmedV1,
  OrderShipmentLabelPurchasedV1,
  OrderShippedV1,
  OrderSlaBreachEscalatedV1,
  OrderSlaBreachEscalationReaffirmedV1,
  OrderTypingCompletedV1,
  OrderTypingMissingInfoV1,
  OrderTypingResumedV1,
  OrderTypingStartedV1,
  // org / organization
  OrgBucketCreatedV1,
  OrgBucketDeletedV1,
  OrgBucketUpdatedV1,
  OrgBucketsProvisionedV1,
  OrgRoleCreatedV1,
  OrgRolePermissionsUpdatedV1,
  OrgSiteAddressUpdatedV1,
  OrgUserInvitedV1,
  OrgUserRoleGrantedV1,
  OrgUserRoleRevokedV1,
  OrganizationCreatedV1,
  // platform
  PlatformApiKeyCreatedV1,
  PlatformApiKeyRevokedV1,
  PlatformWebhookSubscriptionCreatedV1,
  PlatformWebhookSubscriptionRevokedV1,
  PlatformWebhookSubscriptionSecretRotatedV1,
  // patient
  PatientAllergyHistoryAssertedV1,
  PatientAllergyRecordedV1,
  PatientAllergyStatusAmendedV1,
  PatientCryptoShreddedV1,
  PatientRegisteredV1,
  PatientUpdatedV1,
  PatientViewedV1,
  // prescription
  PrescriptionCreatedV1,
  // provider
  ProviderDeactivatedV1,
  ProviderOnboardingApprovedV1,
  ProviderOnboardingRejectedV1,
  ProviderOnboardingReviewRequiredV1,
  ProviderOnboardingSubmittedV1,
  ProviderPortalAccountActivatedV1,
  ProviderPortalAccountPasswordChangedV1,
  ProviderPortalAccountProvisionedV1,
  ProviderPortalAccountSignedInV1,
  ProviderReactivatedV1,
  ProviderRegisteredV1,
  ProviderUpdatedV1,
  // reporting
  ReportingRunCompletedV1,
  ReportScheduleCreatedV1,
  ReportScheduleDisabledV1,
  ReportScheduleUpdatedV1,
  // shipment
  ShipmentTrackingRecordedV1,
  // shipping
  ShippingCarrierCredentialRegisteredV1,
  ShippingPackagePhotoArchivedV1,
  ShippingPackagePhotoCapturedV1,
  ShippingPackagePhotoMatchResolvedV1,
  // user (auth engine)
  UserDeactivatedV1,
  UserInviteAcceptedV1,
  UserInviteIssuedV1,
  UserMfaEnrolledV1,
  UserMfaEnrollmentStartedV1,
  UserPasswordChangedV1,
  UserPasswordResetRequestedV1,
  UserPasswordResetV1,
  UserSessionsRevokedV1,
  UserSignedInV1,
  UserWebAuthnAuthenticationStartedV1,
  UserWebAuthnCredentialEnrolledV1,
  UserWebAuthnRegistrationStartedV1,
  // workflow
  WorkflowOverlayUpsertedV1,
]) as ReadonlyArray<EventDefinition<Record<string, unknown>>>;

function buildRegistry(): ReadonlyMap<string, EventDefinition<Record<string, unknown>>> {
  const map = new Map<string, EventDefinition<Record<string, unknown>>>();
  for (const def of ALL_DEFINITIONS) {
    if (!EVENT_NAME_REGEX.test(def.fullName)) {
      // Defensive — `defineEvent` already validates this. A failure
      // here would mean a bug in the factory, not user error.
      throw new Error(
        `EVENT_REGISTRY: definition fullName "${def.fullName}" does not match ${EVENT_NAME_REGEX.source}.`
      );
    }
    if (map.has(def.fullName)) {
      throw new Error(`EVENT_REGISTRY: duplicate registration for "${def.fullName}".`);
    }
    map.set(def.fullName, def);
  }
  return Object.freeze(map);
}

/**
 * The frozen vocabulary lookup. Keyed by the full versioned name
 * (`order.shipped.v1`). Consumers should treat values as opaque
 * `EventDefinition` references; reach for `getEventDefinition` if
 * you have only a string.
 */
export const EVENT_REGISTRY: ReadonlyMap<
  string,
  EventDefinition<Record<string, unknown>>
> = buildRegistry();

/**
 * Look up an event definition by its full versioned name. Returns
 * `undefined` for unregistered names so the legacy `emit()` overload
 * can fall back to a pass-through draft during migration.
 */
export function getEventDefinition(
  fullName: string
): EventDefinition<Record<string, unknown>> | undefined {
  return EVENT_REGISTRY.get(fullName);
}

/**
 * Snapshot of the registered event names. Sorted alphabetically so
 * test output and audit dumps are deterministic across runs.
 */
export function listRegisteredEventNames(): ReadonlyArray<string> {
  return Object.freeze([...EVENT_REGISTRY.keys()].sort());
}

/**
 * Snapshot of the full registered event-definition list. Sorted by
 * `fullName` lexicographically (raw codepoint order) so the generated
 * catalog and audit dumps are LOCALE-INDEPENDENT and stable across
 * environments. Useful for docs generation and the `validate-registry`
 * CLI tool.
 *
 * Why lexicographic and not `localeCompare`: locale-aware collation
 * treats `.` and `_` differently across locales (en-US ignores `.` as
 * a separator while ranking `_` as a regular letter), so two CI hosts
 * with different default locales would produce different orders and
 * the parity test in `index.test.ts` would oscillate. The test pins
 * `[...names].sort()` (raw codepoint order); we mirror it here.
 */
export function listRegisteredEventDefinitions(): ReadonlyArray<
  EventDefinition<Record<string, unknown>>
> {
  const sorted = [...EVENT_REGISTRY.values()].sort((a, b) =>
    a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0
  );
  return Object.freeze(sorted);
}
