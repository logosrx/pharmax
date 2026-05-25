export type { VialLabelRenderInput } from "./types.js";
export { buildVialBarcodeValue } from "./build-barcode-value.js";
export { hashZplContent } from "./hash-zpl-content.js";
export {
  DEFAULT_VIAL_TEMPLATE_CODE,
  DEFAULT_VIAL_TEMPLATE_VERSION,
  DEFAULT_VIAL_ZPL_TEMPLATE,
} from "./default-vial-template.js";
export { renderVialLabelZpl } from "./render-vial-label-zpl.js";
export {
  VIAL_LABEL_REPRINT_REASONS,
  VIAL_LABEL_REPRINT_REASONS_SET,
  isVialLabelReprintReason,
  type VialLabelReprintReason,
} from "./reprint-reasons.js";
export {
  ConfirmVialLabelPrint,
  type ConfirmVialLabelPrintInput,
  type ConfirmVialLabelPrintOutput,
  PRINT_JOB_NOT_FOUND,
  PRINT_JOB_NOT_CONFIRMABLE,
} from "./commands/confirm-vial-label-print.js";

import * as confirmVialLabelPrintModule from "./commands/confirm-vial-label-print.js";

export const labels = {
  commands: {
    ConfirmVialLabelPrint: confirmVialLabelPrintModule.ConfirmVialLabelPrint,
  },
} as const;
