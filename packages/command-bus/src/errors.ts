// Command-bus error factories.
//
// Every error thrown out of `executeCommand` / `executeSystemCommand`
// is a `PharmaxError` subclass with a stable `code`. The codes are
// part of the public contract — route handlers, audit dashboards,
// and alert rules match on them. Renaming a code is a breaking
// change.
//
// PHI invariant: messages and `metadata` MUST NOT include decrypted
// patient identifiers, request bodies, or response payloads. The
// bus's PHI scrubbing happens at write time on
// command_log / audit_log / event_outbox; errors flowing back to
// the caller stay generic.

import { errors as coreErrors } from "@pharmax/platform-core";

export const COMMAND_BUS_NOT_CONFIGURED = "COMMAND_BUS_NOT_CONFIGURED";
export const COMMAND_INPUT_INVALID = "COMMAND_INPUT_INVALID";
export const COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH = "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH";
export const COMMAND_IN_FLIGHT = "COMMAND_IN_FLIGHT";
export const COMMAND_ALREADY_EXECUTED = "COMMAND_ALREADY_EXECUTED";
export const COMMAND_WORKSTATION_REQUIRED = "COMMAND_WORKSTATION_REQUIRED";
export const COMMAND_SYSTEM_CONTEXT_REQUIRED = "COMMAND_SYSTEM_CONTEXT_REQUIRED";

export function commandBusNotConfiguredError(): coreErrors.InternalError {
  return new coreErrors.InternalError({
    code: COMMAND_BUS_NOT_CONFIGURED,
    message:
      "Command bus is not configured. Call configureCommandBus() at process boot before dispatching commands.",
  });
}

export interface CommandInputInvalidIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

export function commandInputInvalidError(input: {
  readonly commandName: string;
  readonly issues: ReadonlyArray<CommandInputInvalidIssue>;
}): coreErrors.ValidationError {
  return new coreErrors.ValidationError({
    code: COMMAND_INPUT_INVALID,
    message: `Input failed validation for command ${input.commandName}`,
    issues: input.issues.map((issue) => ({
      path: [...issue.path],
      message: issue.message,
    })),
    metadata: { commandName: input.commandName },
  });
}

/**
 * A concurrent request with the same idempotency key is still
 * executing. Stable 409 — the client should wait and retry the SAME
 * key (which will replay the winner's response once it commits),
 * not resubmit with a new key.
 */
export function commandInFlightError(input: {
  readonly commandName: string;
}): coreErrors.ConflictError {
  return new coreErrors.ConflictError({
    code: COMMAND_IN_FLIGHT,
    message: `A request with this idempotency key for command ${input.commandName} is already executing. Retry with the same key shortly.`,
    metadata: { commandName: input.commandName },
  });
}

/**
 * A prior attempt with this key SUCCEEDED but the cached response
 * is no longer available (idempotency row expired or was purged).
 * The command must NOT re-execute; the caller needs a new key if
 * this is genuinely a new request.
 */
export function commandAlreadyExecutedError(input: {
  readonly commandName: string;
}): coreErrors.ConflictError {
  return new coreErrors.ConflictError({
    code: COMMAND_ALREADY_EXECUTED,
    message: `A request with this idempotency key for command ${input.commandName} already executed, but its cached response has expired. Use a new idempotency key for a new request.`,
    metadata: { commandName: input.commandName },
  });
}

export function commandWorkstationRequiredError(input: {
  readonly commandName: string;
}): coreErrors.AuthorizationError {
  return new coreErrors.AuthorizationError({
    code: COMMAND_WORKSTATION_REQUIRED,
    message: `Command ${input.commandName} can only be dispatched from a paired workstation.`,
    metadata: { commandName: input.commandName },
  });
}

export function commandSystemContextRequiredError(input: {
  readonly commandName: string;
}): coreErrors.AuthorizationError {
  return new coreErrors.AuthorizationError({
    code: COMMAND_SYSTEM_CONTEXT_REQUIRED,
    message: `Command ${input.commandName} must be invoked inside withSystemContext(...).`,
    metadata: { commandName: input.commandName },
  });
}
