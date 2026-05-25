// 400 Bad Request — the request shape or values are invalid.
//
// This is the right error for:
//   - Zod schema parse failures at the route boundary.
//   - Type-system-correct but business-invalid input (e.g. negative
//     quantity, expired idempotency key TTL).
//
// It is NOT the right error for:
//   - "User cannot do this action" (use AuthorizationError).
//   - "Order is in the wrong status" (use ConflictError).
//   - "Lot is expired" (use InvariantViolationError).

import { PharmaxError, type PharmaxErrorInit } from "./pharmax-error.js";

export interface FieldIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly code?: string;
}

export interface ValidationErrorInit extends PharmaxErrorInit {
  readonly issues?: ReadonlyArray<FieldIssue>;
}

export class ValidationError extends PharmaxError {
  public override readonly httpStatus = 400;
  public override readonly category = "expected" as const;
  public readonly issues: ReadonlyArray<FieldIssue>;

  public constructor(init: ValidationErrorInit) {
    super(init);
    this.issues = Object.freeze([...(init.issues ?? [])]);
  }

  public override toJSON(): ReturnType<PharmaxError["toJSON"]> & {
    readonly issues: ReadonlyArray<FieldIssue>;
  } {
    return {
      ...super.toJSON(),
      issues: this.issues,
    };
  }
}
