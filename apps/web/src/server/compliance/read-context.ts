// Shared read wrapper for the compliance control plane.
//
// Compliance tables are platform-level, not tenant-scoped: a control
// like "every tenant table has an RLS policy" belongs to Pharmax, not
// to any one organization, and its evidence has to outlive the tenants
// it examined. They are therefore registered in
// TENANT_EXCLUDED_MODELS, which means the tenancy extension will not
// inject an organization filter — and equally will not fail closed if
// a caller forgets one.
//
// That makes the system-context wrapper load-bearing rather than
// ceremonial. It is the thing that states, in the ALS context and in
// the session GUC the database sees, that this read is deliberately
// cross-tenant and why — without the GUC these reads fail closed under
// the non-BYPASSRLS `pharmax_app` runtime role.
//
// This delegates to `readInSystemContext` rather than reaching for
// `withSystemContext` directly. That helper is the reviewed read-side
// analogue of the command bus's system path, and keeping the escape
// hatch inside @pharmax/database is what lets the import restriction in
// eslint.config.js stay unqualified for apps/web.
//
// The reason string is required and shows up in database session
// state, so make it name the page, not the table.

import "server-only";

import { readInSystemContext, type PrismaClient } from "@pharmax/database";

/**
 * Transaction client passed to compliance read callbacks. Narrowed to
 * the compliance delegates so a helper in this directory cannot
 * quietly reach for `order` or `patient` — those are tenant-scoped and
 * have no business being read without an organization filter.
 */
export type ComplianceReadTx = Pick<
  PrismaClient,
  | "complianceControl"
  | "complianceCriterion"
  | "complianceControlCriterion"
  | "complianceCheck"
  | "complianceCheckControl"
  | "complianceCheckRun"
  | "complianceCheckException"
  | "complianceTask"
>;

export function readCompliance<T>(
  reason: string,
  fn: (tx: ComplianceReadTx) => Promise<T>
): Promise<T> {
  return readInSystemContext(`web:compliance:${reason}`, (tx) =>
    fn(tx as unknown as ComplianceReadTx)
  );
}
