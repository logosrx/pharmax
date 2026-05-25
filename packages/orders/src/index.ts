// Public surface of @pharmax/orders.
//
// Domain package that owns the order-aggregate commands and the
// per-command event-vocabulary translator used by the bus's SoD
// helper. Every order command in this package is built via
// `defineCommand` from `@pharmax/command-bus`; the factory codifies
// the 20-step contract so each command file is purely the
// business-rule layer.
//
// Convention (mirrors `@pharmax/orgs`):
//
//   - Commands are exported individually AND under a `commands`
//     namespace on the `orders` object.
//   - Each command's input/output types are re-exported here so
//     callers depend on `@pharmax/orders`, not on the file path.
//   - The event-type → permission translator is exported alongside
//     so the bus's SoD helper can use it from any future command
//     in this package or downstream packages that consume the same
//     vocabulary.

export {
  CreateOrder,
  type CreateOrderInput,
  type CreateOrderOutput,
  ORDER_CLINIC_NOT_FOUND,
  ORDER_SITE_NOT_FOUND,
  ORDER_SITE_NOT_LINKED_TO_CLINIC,
  ORDER_PATIENT_NOT_FOUND,
  ORDER_PATIENT_CLINIC_MISMATCH,
  ORDER_PRESCRIPTION_NOT_FOUND,
  ORDER_PRESCRIPTION_MISMATCH,
  ORDER_INTAKE_BUCKET_NOT_CONFIGURED,
} from "./commands/create-order.js";

export {
  ADDABLE_STATES,
  AddPrescription,
  type AddPrescriptionInput,
  type AddPrescriptionOutput,
  ORDER_NOT_IN_ADDABLE_STATE,
  ORDER_PRESCRIPTION_ALREADY_ON_ORDER,
} from "./commands/add-prescription.js";

export {
  CancelOrder,
  type CancelOrderInput,
  type CancelOrderOutput,
  ORDER_CANCEL_POLICY_UNSUPPORTED,
  ORDER_STATE_UNKNOWN,
  ORDER_ALREADY_TERMINAL,
  ORDER_CANCEL_INVALID_FROM,
  ORDER_ALREADY_CANCELLED,
} from "./commands/cancel-order.js";

export {
  PlaceHold,
  type PlaceHoldInput,
  type PlaceHoldOutput,
  ORDER_PLACE_HOLD_POLICY_UNSUPPORTED,
  ORDER_HOLD_STATE_UNKNOWN,
  ORDER_HOLD_INVALID_FROM,
  ORDER_HOLD_TERMINAL_STATE,
  ORDER_ALREADY_ON_HOLD,
} from "./commands/place-hold.js";

export {
  ReleaseHold,
  type ReleaseHoldInput,
  type ReleaseHoldOutput,
  ORDER_RELEASE_HOLD_POLICY_UNSUPPORTED,
  ORDER_RELEASE_STATE_UNKNOWN,
  ORDER_NOT_ON_HOLD,
  ORDER_RELEASE_INVALID_TARGET,
  ORDER_HOLD_RECORD_CORRUPT,
} from "./commands/release-hold.js";

export {
  ReopenForCorrection,
  type ReopenForCorrectionInput,
  type ReopenForCorrectionOutput,
  ORDER_REOPEN_POLICY_UNSUPPORTED,
  ORDER_REOPEN_STATE_UNKNOWN,
  ORDER_REOPEN_INVALID_FROM,
  ORDER_REOPEN_TERMINAL_STATE,
  ORDER_REOPEN_INVALID_TARGET,
  ORDER_REOPEN_PARAM_REQUIRED,
  ORDER_REOPEN_BUCKET_NOT_CONFIGURED,
} from "./commands/reopen-for-correction.js";

export {
  REOPEN_REASONS,
  REOPEN_TARGET_STATES,
  isReopenReason,
  isReopenTargetState,
  type ReopenReasonCode,
  type ReopenTargetState,
} from "./reopen-reasons.js";

export { ORDER_EVENT_TYPE_TO_PERMISSION, orderEventTypeToPermission } from "./events.js";

import * as createOrderModule from "./commands/create-order.js";
import * as addPrescriptionModule from "./commands/add-prescription.js";
import * as cancelOrderModule from "./commands/cancel-order.js";
import * as placeHoldModule from "./commands/place-hold.js";
import * as releaseHoldModule from "./commands/release-hold.js";
import * as reopenForCorrectionModule from "./commands/reopen-for-correction.js";

export const orders = {
  commands: {
    CreateOrder: createOrderModule.CreateOrder,
    AddPrescription: addPrescriptionModule.AddPrescription,
    CancelOrder: cancelOrderModule.CancelOrder,
    PlaceHold: placeHoldModule.PlaceHold,
    ReleaseHold: releaseHoldModule.ReleaseHold,
    ReopenForCorrection: reopenForCorrectionModule.ReopenForCorrection,
  },
} as const;
