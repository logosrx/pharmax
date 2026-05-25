export {
  ReleaseToShip,
  type ReleaseToShipInput,
  type ReleaseToShipOutput,
  ORDER_VERSION_MISMATCH,
  SHIP_POLICY_UNSUPPORTED,
  SHIP_ORDER_STATE_UNKNOWN,
  SHIP_INVALID_TRANSITION,
  SHIP_ORDER_TERMINAL,
  SHIPPING_BUCKET_NOT_CONFIGURED,
} from "./commands/release-to-ship.js";

export {
  CreateShipment,
  type CreateShipmentInput,
  type CreateShipmentOutput,
  SHIPMENT_ALREADY_EXISTS,
} from "./commands/create-shipment.js";

export {
  ConfirmShipment,
  type ConfirmShipmentInput,
  type ConfirmShipmentOutput,
  SHIPMENT_NOT_FOUND,
  SHIPMENT_NOT_READY,
} from "./commands/confirm-shipment.js";

export {
  PurchaseShipmentLabel,
  type PurchaseShipmentLabelInput,
  type PurchaseShipmentLabelOutput,
  PURCHASE_LABEL_ADAPTER_FAILED,
} from "./commands/purchase-shipment-label.js";

export {
  RegisterCarrierCredential,
  type RegisterCarrierCredentialInput,
  type RegisterCarrierCredentialOutput,
} from "./commands/register-carrier-credential.js";

export {
  RecordShipmentTrackingEvent,
  type RecordShipmentTrackingEventInput,
  type RecordShipmentTrackingEventOutput,
  SHIPMENT_TRACKING_SHIPMENT_NOT_FOUND,
  SHIPMENT_TRACKING_DUPLICATE_EVENT,
} from "./commands/record-shipment-tracking-event.js";

export { SHIP_NOT_ASSIGNED_TO_ACTOR, SHIP_WRONG_STATUS } from "./shipping-guards.js";

export {
  verifyEasyPostSignature,
  EasyPostSignatureError,
  EasyPostWebhookConfigError,
  type EasyPostSignatureVerificationResult,
  type VerifyEasyPostSignatureInput,
} from "./carriers/easypost-signature.js";
export {
  normalizeEasyPostStatus,
  shipmentStatusForTrackingKind,
} from "./carriers/easypost-status.js";
export {
  parseEasyPostTrackerWebhook,
  EasyPostPayloadError,
  EASYPOST_TRACKER_EVENT_DESCRIPTIONS,
  easyPostTrackerWebhookSchema,
  type EasyPostTrackerEventDescription,
  type EasyPostTrackerWebhookPayload,
} from "./carriers/easypost-payload.js";

export {
  EasyPostClient,
  EasyPostApiError,
  type EasyPostAddressPayload,
  type EasyPostBuyShipmentRequest,
  type EasyPostClientOptions,
  type EasyPostCreateShipmentRequest,
  type EasyPostParcelPayload,
  type EasyPostRate,
  type EasyPostShipment,
} from "./carriers/easypost-client.js";

export { EasyPostShippingAdapter } from "./carriers/easypost-adapter.js";
export {
  createEasyPostFactory,
  type CreateEasyPostFactoryOptions,
} from "./carriers/easypost-factory.js";

export {
  FedExClient,
  FedExApiError,
  type FedExCancelShipmentRequest,
  type FedExCancelShipmentResponse,
  type FedExClientOptions,
  type FedExRateQuoteRequest,
  type FedExRateQuoteResponse,
  type FedExScanEvent,
  type FedExShipRequest,
  type FedExShipResponse,
  type FedExTrackRequest,
  type FedExTrackResponse,
  type FedExTrackResult,
} from "./carriers/fedex-client.js";
export { FedExShippingAdapter } from "./carriers/fedex-adapter.js";
export { createFedExFactory, type CreateFedExFactoryOptions } from "./carriers/fedex-factory.js";
export {
  FEDEX_SERVICE_TYPES,
  FEDEX_PACKAGING_TYPES,
  findFedExService,
  findFedExPackaging,
  type FedExServiceType,
  type FedExServiceCode,
  type FedExServiceCategory,
  type FedExPackagingType,
  type FedExPackagingCode,
} from "./carriers/fedex-services.js";
export { normalizeFedExStatus, isFedExTrackingNumber } from "./carriers/fedex-status.js";

export {
  UpsClient,
  UpsApiError,
  type UpsClientOptions,
  type UpsShipRequest,
  type UpsShipResponse,
  type UpsTrackBatchEntry,
  type UpsTrackBatchResponse,
  type UpsTrackPackage,
  type UpsTrackResponse,
} from "./carriers/ups-client.js";
export { UpsShippingAdapter } from "./carriers/ups-adapter.js";
export { createUpsFactory, type CreateUpsFactoryOptions } from "./carriers/ups-factory.js";
export { normalizeUpsStatus, isUpsTrackingNumber } from "./carriers/ups-status.js";

export type {
  CancelLabelResult,
  PurchaseLabelInput,
  PurchasedLabel,
  ShippingAdapter,
  ShippingAddress,
  ShippingParcel,
} from "./carriers/shipping-adapter.js";

export {
  configureShipping,
  getShippingConfiguration,
  getShippingAdapterFactory,
  resetShippingConfigurationForTests,
  type CarrierCredentialContext,
  type ShippingAdapterFactory,
  type ShippingConfiguration,
} from "./configure.js";

export {
  resolveShippingAdapter,
  SHIPPING_CREDENTIAL_NOT_FOUND,
  type ResolveShippingAdapterInput,
  type ResolvedShippingAdapter,
} from "./resolve-adapter.js";

export {
  handleEasyPostWebhook,
  type HandleEasyPostWebhookDeps,
  type HandleEasyPostWebhookInput,
  type HandleEasyPostWebhookResult,
} from "./webhooks/handle-easypost-webhook.js";

export {
  processEasyPostWebhookEvent,
  executeEasyPostWebhookEventDispatch,
  type ProcessEasyPostWebhookEventDeps,
  type ProcessEasyPostWebhookEventResult,
  type ResolvedWebhookTarget,
  type WebhookTargetResolver,
} from "./webhooks/process-easypost-webhook-event.js";

export { InMemoryEasyPostWebhookEventStore } from "./webhooks/in-memory-event-store.js";

export {
  PrismaEasyPostWebhookEventStore,
  type EasyPostWebhookEventClient,
} from "./webhooks/prisma-event-store.js";

export type {
  EasyPostWebhookEventRecord,
  EasyPostWebhookEventStatus,
  EasyPostWebhookEventStore,
  RecordReceivedInput,
  RecordReceivedResult,
} from "./webhooks/event-store.js";

export { EasyPostWebhookEventNotFoundError } from "./webhooks/errors.js";

import * as confirmShipmentModule from "./commands/confirm-shipment.js";
import * as createShipmentModule from "./commands/create-shipment.js";
import * as purchaseShipmentLabelModule from "./commands/purchase-shipment-label.js";
import * as recordShipmentTrackingEventModule from "./commands/record-shipment-tracking-event.js";
import * as registerCarrierCredentialModule from "./commands/register-carrier-credential.js";
import * as releaseToShipModule from "./commands/release-to-ship.js";

export const shipping = {
  commands: {
    ReleaseToShip: releaseToShipModule.ReleaseToShip,
    CreateShipment: createShipmentModule.CreateShipment,
    PurchaseShipmentLabel: purchaseShipmentLabelModule.PurchaseShipmentLabel,
    ConfirmShipment: confirmShipmentModule.ConfirmShipment,
    RecordShipmentTrackingEvent: recordShipmentTrackingEventModule.RecordShipmentTrackingEvent,
    RegisterCarrierCredential: registerCarrierCredentialModule.RegisterCarrierCredential,
  },
} as const;
