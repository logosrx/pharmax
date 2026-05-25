// 422 Unprocessable Entity — request is well-formed and authorized
// but violates a workflow / business invariant.
//
// Use for the non-negotiable rules in `.cursor/rules/01-workflow-safety.mdc`:
//   - "No fill before PV1 approval."
//   - "No final verification before fill completion."
//   - "No expired lot assignment."
//   - "Every cancellation requires a disposition reason."
//   - etc.
//
// These are EXPECTED in normal operations (users will occasionally try
// the wrong thing). They surface as a clear UI error and SHOULD NOT
// page. The metadata MUST carry the rule code (e.g. `WF_NO_FILL_BEFORE_PV1`)
// so dashboards can graph rejection rates per rule for UX work.

import { PharmaxError } from "./pharmax-error.js";

export class InvariantViolationError extends PharmaxError {
  public override readonly httpStatus = 422;
  public override readonly category = "expected" as const;
}
