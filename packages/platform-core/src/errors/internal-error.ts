// 500 Internal Server Error — the operation failed for a reason that
// is NOT caller-fixable (DB unreachable, bug in our code, downstream
// service hard-down, JSON parse of a Stripe payload we already
// signature-verified, etc.).
//
// This is the ONLY category in the hierarchy with `category =
// "unexpected"`. The command bus, route handlers, and worker drainers
// treat it as page-worthy: log at ERROR, ship to Sentry, increment
// an alert metric. ValidationError / AuthorizationError / etc. should
// NEVER bubble up as InternalError — wrap them appropriately at the
// boundary they cross.
//
// Route responses for InternalError MUST NOT echo the `message` field
// verbatim to the client — that message often contains stack traces,
// SQL fragments, or env names that should not be exposed.

import { PharmaxError } from "./pharmax-error.js";

export class InternalError extends PharmaxError {
  public override readonly httpStatus = 500;
  public override readonly category = "unexpected" as const;
}
