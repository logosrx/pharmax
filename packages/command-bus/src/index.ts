// Public surface of @pharmax/command-bus.
//
// Two import styles supported:
//
//     // Named:
//     import { executeCommand, defineCommand } from "@pharmax/command-bus";
//
//     // Namespaced:
//     import { commandBus } from "@pharmax/command-bus";
//     await commandBus.executeCommand(MyCommand, input, { idempotencyKey });

export {
  configureCommandBus,
  getCommandBusConfiguration,
  resetCommandBusConfigurationForTests,
  type CommandBusConfiguration,
} from "./configure.js";

export type {
  AuditEntryDraft,
  Command,
  ExecuteOptions,
  HandlerDeps,
  HandlerResult,
  OutboxEventDraft,
  PrismaTxClient,
  SystemCommand,
  SystemHandlerResult,
} from "./types.js";

export { executeCommand } from "./execute-command.js";
export { executeSystemCommand, type ExecuteSystemOptions } from "./execute-system-command.js";

export {
  defineCommand,
  DEFINE_COMMAND_CONFIG_INVALID,
  ORDER_NOT_FOUND,
  ORDER_VERSION_MISMATCH,
  WORKFLOW_POLICY_INACTIVE,
  WORKFLOW_POLICY_NOT_FOUND,
  type BumpVersionInstruction,
  type DefineCommandExecDeps,
  type DefineCommandExecResult,
  type DefineCommandSpec,
  type LoadedPolicy,
  type LoadPolicySpec,
  type LockableTable,
  type LockedOrderTarget,
  type LockTargetSpec,
  type SagaRegistry,
  type SagaStep,
  type SoDRuleSpec,
} from "./define-command.js";

export { canonicalStringify, hashRequest } from "./hash.js";
export { redactPayload, REDACT_CENSOR } from "./redact.js";

export {
  lookupIdempotency,
  storeIdempotencyInTx,
  type LookupIdempotencyInput,
  type LookupResult,
  type StoreIdempotencyInput,
} from "./idempotency.js";

export {
  buildEventTypeTranslator,
  loadOrderResourceHistory,
  requireNoSoDViolationForOrder,
  type EventTypeToPermission,
  type LoadOrderResourceHistoryInput,
  type RequireNoSoDViolationForOrderInput,
} from "./sod.js";

export {
  COMMAND_BUS_NOT_CONFIGURED,
  COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH,
  COMMAND_INPUT_INVALID,
  COMMAND_SYSTEM_CONTEXT_REQUIRED,
  COMMAND_WORKSTATION_REQUIRED,
  commandBusNotConfiguredError,
  commandInputInvalidError,
  commandSystemContextRequiredError,
  commandWorkstationRequiredError,
  type CommandInputInvalidIssue,
} from "./errors.js";

import * as configureModule from "./configure.js";
import * as defineCommandModule from "./define-command.js";
import * as errorsModule from "./errors.js";
import * as executeModule from "./execute-command.js";
import * as executeSystemModule from "./execute-system-command.js";
import * as hashModule from "./hash.js";
import * as idempotencyModule from "./idempotency.js";
import * as redactModule from "./redact.js";
import * as sodModule from "./sod.js";

export const commandBus = {
  ...configureModule,
  ...defineCommandModule,
  ...errorsModule,
  ...executeModule,
  ...executeSystemModule,
  ...hashModule,
  ...idempotencyModule,
  ...redactModule,
  ...sodModule,
} as const;
