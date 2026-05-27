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
  type AttestationRequirement,
  type OrderTransitionRow,
  type OrderWorkflowPolicy,
} from "./policy-v1.js";

export {
  OVERLAY_LOOSENS_BASE_POLICY,
  applyOverlays,
  buildMergedPolicy,
  composeOverlays,
  mergePolicyWithOverlay,
  type MergedWorkflowPolicy,
  type WorkflowPolicyOverlay,
  type WorkflowPolicyOverlayBinding,
  type WorkflowPolicyOverlayErrorCode,
} from "./policy-overlay.js";

export {
  DEFAULT_OVERLAY_CACHE_TTL_MS,
  InMemoryOverlaySource,
  WorkflowPolicyOverlayCache,
  invalidatePolicyCache,
  resolvePolicyForTenant,
  type OverlayLoadInput,
  type OverlaySource,
  type ResolvePolicyForTenantDeps,
  type ResolvePolicyForTenantInput,
} from "./policy-overlay-resolver.js";

export {
  applyTransition,
  canTransition,
  extraEventsFor,
  extraWritesFor,
  getReachableCommands,
  nextStatusFor,
  validateTransition,
  type ApplyTransitionInput,
  type ApplyTransitionResult,
  type ExtraWriteDescriptor,
} from "./engine.js";

export {
  BUCKET_CODE_FOR_EXCEPTION_STATE,
  BUCKET_CODE_FOR_STATUS,
  bucketCodeForStatus,
} from "./status-bucket-map.js";

export {
  CREATE_READABLE_STATUSES,
  IN_FLIGHT_READABLE_STATUSES,
  OVERLAY_DEACTIVATION_BLOCKED,
  OVERLAY_NOT_ACTIVE,
  OVERLAY_NOT_DRAFT,
  OVERLAY_NOT_FOUND,
  OVERLAY_STATUS_VALUES,
  POLICY_VERSION_BREAKING_NARROWING,
  POLICY_VERSION_DUPLICATE,
  POLICY_VERSION_NOT_DRAFT,
  POLICY_VERSION_NOT_INCREMENTAL,
  WORKFLOW_POLICY_NOT_ACTIVE,
  WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE,
  WORKFLOW_POLICY_STATUS_VALUES,
  diffPolicyTransitions,
  isWorkflowPolicyStatus,
  pickPolicyForCreate,
  validateActivateOverlay,
  validateActivatePolicyVersion,
  validateDeactivateOverlay,
  validateRegisterPolicyVersion,
  type ActivateOverlayInput,
  type ActivatePolicyVersionInput,
  type DeactivateOverlayInput,
  type ExistingOverlayRow,
  type ExistingPolicyVersionRow,
  type LifecycleValidation,
  type OverlayLifecycleErrorCode,
  type OverlayStatusValue,
  type PickPolicyForCreateInput,
  type PickPolicyForCreateResult,
  type PolicyLifecycleErrorCode,
  type PolicySelectionErrorCode,
  type RegisterPolicyVersionInput,
  type WorkflowPolicyCandidate,
  type WorkflowPolicyStatusValue,
} from "./policy-lifecycle.js";

import * as commandsModule from "./commands.js";
import * as engineModule from "./engine.js";
import * as errorsModule from "./errors.js";
import * as policyLifecycleModule from "./policy-lifecycle.js";
import * as policyOverlayResolverModule from "./policy-overlay-resolver.js";
import * as policyOverlayModule from "./policy-overlay.js";
import * as policyModule from "./policy-v1.js";
import * as statesModule from "./states.js";
import * as statusBucketModule from "./status-bucket-map.js";

export const workflow = {
  ...statesModule,
  ...commandsModule,
  ...errorsModule,
  ...policyModule,
  ...policyOverlayModule,
  ...policyOverlayResolverModule,
  ...policyLifecycleModule,
  ...engineModule,
  ...statusBucketModule,
} as const;
