// 403 Forbidden — caller is authenticated but lacks permission.
//
// Reserve for RBAC denials, tenancy scope mismatches, and "user is
// allowed in general but not for THIS resource" (e.g. trying to fill
// an order in a clinic they don't belong to). The metadata should
// include the permission code and the offending scope so security
// audits can correlate denials without leaking PHI.

import { PharmaxError } from "./pharmax-error.js";

export class AuthorizationError extends PharmaxError {
  public override readonly httpStatus = 403;
  public override readonly category = "expected" as const;
}
