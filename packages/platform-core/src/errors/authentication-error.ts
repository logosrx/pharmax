// 401 Unauthorized — caller's identity could not be verified.
//
// Reserve for missing/expired/invalid session, malformed JWT, etc.
// "User is not allowed to do this action" is 403 AuthorizationError.

import { PharmaxError } from "./pharmax-error.js";

export class AuthenticationError extends PharmaxError {
  public override readonly httpStatus = 401;
  public override readonly category = "expected" as const;
}
