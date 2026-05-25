// 409 Conflict — the operation cannot be applied because of a
// concurrency or state-race condition.
//
// Use for:
//   - Idempotency-key collision with a different request hash.
//   - Optimistic-lock version mismatch on order updates.
//   - "This order is already PROCESSING" (a different worker beat us).
//
// NOT for business-rule violations like "no fill before PV1" — those
// are InvariantViolationError (422). The distinction matters for
// alerting: ConflictError volume is a concurrency-tuning signal,
// InvariantViolationError volume is a UX/training signal.

import { PharmaxError } from "./pharmax-error.js";

export class ConflictError extends PharmaxError {
  public override readonly httpStatus = 409;
  public override readonly category = "expected" as const;
}
