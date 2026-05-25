// Public surface of @pharmax/workflow.
//
// Two import styles:
//
//     // Named:
//     import { applyTransition, ORDER_STANDARD_V1 } from "@pharmax/workflow";
//
//     // Namespaced:
//     import { workflow } from "@pharmax/workflow";
//     workflow.applyTransition({ policy: workflow.ORDER_STANDARD_V1, ... });

export {
  ALL_ORDER_STATES,
  ORDER_EXCEPTION_STATES,
  ORDER_PRIMARY_STATES,
  ORDER_TERMINAL_STATES,
  isOrderState,
  isPrimaryState,
  isTerminalState,
  type OrderExceptionState,
  type OrderPrimaryState,
  type OrderState,
  type OrderTerminalState,
} from "./states.js";

export {
  ORDER_WORKFLOW_COMMANDS,
  isOrderWorkflowCommand,
  type OrderWorkflowCommand,
} from "./commands.js";

export {
  WORKFLOW_INVALID_TRANSITION,
  WORKFLOW_PARAM_INVALID,
  WORKFLOW_PARAM_REQUIRED,
  WORKFLOW_STATE_TERMINAL,
  WORKFLOW_UNKNOWN_COMMAND,
  type WorkflowErrorCode,
} from "./errors.js";

export {
  CANCEL_FROM_STATES,
  HOLD_FROM_STATES,
  ORDER_STANDARD_V1,
  ORDER_STANDARD_V1_TRANSITIONS,
  REOPEN_TARGETS_BY_SOURCE,
  type OrderTransitionRow,
  type OrderWorkflowPolicy,
} from "./policy-v1.js";

export {
  applyTransition,
  canTransition,
  getReachableCommands,
  type ApplyTransitionInput,
  type ApplyTransitionResult,
} from "./engine.js";

export {
  BUCKET_CODE_FOR_EXCEPTION_STATE,
  BUCKET_CODE_FOR_STATUS,
  bucketCodeForStatus,
} from "./status-bucket-map.js";

import * as commandsModule from "./commands.js";
import * as engineModule from "./engine.js";
import * as errorsModule from "./errors.js";
import * as policyModule from "./policy-v1.js";
import * as statesModule from "./states.js";
import * as statusBucketModule from "./status-bucket-map.js";

export const workflow = {
  ...statesModule,
  ...commandsModule,
  ...errorsModule,
  ...policyModule,
  ...engineModule,
  ...statusBucketModule,
} as const;
