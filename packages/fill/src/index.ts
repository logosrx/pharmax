export {
  StartFill,
  type StartFillInput,
  type StartFillOutput,
  ORDER_VERSION_MISMATCH,
} from "./commands/start-fill.js";

export {
  AssignLot,
  type AssignLotInput,
  type AssignLotOutput,
  LOT_NOT_FOUND,
  LOT_HELD,
  LOT_EXPIRED,
  LOT_PRODUCT_MISMATCH,
  LOT_SITE_MISMATCH,
  ORDER_LINE_NOT_FOUND,
} from "./commands/assign-lot.js";

export {
  PrintVialLabel,
  type PrintVialLabelInput,
  type PrintVialLabelOutput,
  PRINTER_NOT_FOUND,
  PRINTER_NOT_THERMAL,
  PRINTER_INACTIVE,
  PRINT_TEMPLATE_NOT_FOUND,
  VIAL_LABEL_ALREADY_EXISTS,
} from "./commands/print-vial-label.js";

export {
  ReprintVialLabel,
  type ReprintVialLabelInput,
  type ReprintVialLabelOutput,
  VIAL_LABEL_NOT_FOUND,
} from "./commands/reprint-vial-label.js";

export {
  CompleteFill,
  type CompleteFillInput,
  type CompleteFillOutput,
  FILL_LOT_NOT_ASSIGNED,
  FILL_LABEL_PRINT_NOT_COMPLETE,
  FILL_SCAN_DUPLICATE_LINE,
  FILL_SCAN_LINE_COUNT_MISMATCH,
  FILL_SCAN_LOT_MISMATCH,
  FILL_SCAN_NDC_MISMATCH,
  FILL_SCAN_PARSE_FAILED,
  FILL_SCAN_UNKNOWN_LINE,
  FILL_SCAN_VIAL_LABEL_MISMATCH,
} from "./commands/complete-fill.js";

export {
  FILL_POLICY_UNSUPPORTED,
  FILL_ORDER_STATE_UNKNOWN,
  FILL_INVALID_TRANSITION,
  FILL_ORDER_TERMINAL,
  FILL_NOT_ASSIGNED_TO_ACTOR,
  FILL_WRONG_STATUS,
} from "./fill-guards.js";

import * as assignLotModule from "./commands/assign-lot.js";
import * as completeFillModule from "./commands/complete-fill.js";
import * as printVialLabelModule from "./commands/print-vial-label.js";
import * as reprintVialLabelModule from "./commands/reprint-vial-label.js";
import * as startFillModule from "./commands/start-fill.js";

export const fill = {
  commands: {
    StartFill: startFillModule.StartFill,
    AssignLot: assignLotModule.AssignLot,
    PrintVialLabel: printVialLabelModule.PrintVialLabel,
    ReprintVialLabel: reprintVialLabelModule.ReprintVialLabel,
    CompleteFill: completeFillModule.CompleteFill,
  },
} as const;
