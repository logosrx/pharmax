// Error codes raised by the break-glass session module.
//
// All codes are stable strings; renaming requires a deprecation cycle
// because route handlers and the security-digest pipeline may pattern-
// match on them.

import { errors } from "@pharmax/platform-core";

export const BREAK_GLASS_SESSION_REASON_REQUIRED = "BREAK_GLASS_SESSION_REASON_REQUIRED" as const;
export const BREAK_GLASS_SESSION_TICKET_REQUIRED = "BREAK_GLASS_SESSION_TICKET_REQUIRED" as const;
export const BREAK_GLASS_SESSION_ALREADY_CLOSED = "BREAK_GLASS_SESSION_ALREADY_CLOSED" as const;
export const BREAK_GLASS_SESSION_EXPIRED = "BREAK_GLASS_SESSION_EXPIRED" as const;

export function breakGlassSessionAlreadyClosedError(detail: {
  readonly sessionId: string;
}): errors.ConflictError {
  return new errors.ConflictError({
    code: BREAK_GLASS_SESSION_ALREADY_CLOSED,
    message: `Break-glass session ${detail.sessionId} is already closed.`,
    metadata: { sessionId: detail.sessionId },
  });
}

export function breakGlassSessionExpiredError(detail: {
  readonly sessionId: string;
  readonly expiredAt: Date;
}): errors.ConflictError {
  return new errors.ConflictError({
    code: BREAK_GLASS_SESSION_EXPIRED,
    message: `Break-glass session ${detail.sessionId} expired at ${detail.expiredAt.toISOString()}.`,
    metadata: { sessionId: detail.sessionId, expiredAt: detail.expiredAt.toISOString() },
  });
}
