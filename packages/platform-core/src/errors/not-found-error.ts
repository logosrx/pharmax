// 404 Not Found — the requested resource does not exist (or is not
// visible to this caller, which is the same thing from the API
// surface's perspective).
//
// IMPORTANT: never differentiate "does not exist" from "exists but
// you can't see it" in the response message — that leaks the
// existence of records across tenancy boundaries. Both surface as
// the same NotFoundError.

import { PharmaxError } from "./pharmax-error.js";

export class NotFoundError extends PharmaxError {
  public override readonly httpStatus = 404;
  public override readonly category = "expected" as const;
}
