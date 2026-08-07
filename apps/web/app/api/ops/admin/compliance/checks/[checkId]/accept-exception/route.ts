// POST /api/ops/admin/compliance/checks/:checkId/accept-exception
//
// Operator action: accept a failing check as a justified, time-boxed
// exception. Dispatches `AcceptCheckException`, which owns the RBAC
// gate (`compliance.exception.accept`), the duration ceiling, and the
// refusal to stack a second active exception on one check.
//
// The parsing below is intentionally strict about the reason code and
// duration rather than forwarding whatever arrived: a malformed value
// should come back as a readable flash, not as a Zod error string in
// the URL bar.

import {
  AcceptCheckException,
  COMPLIANCE_EXCEPTION_MAX_DAYS,
  COMPLIANCE_EXCEPTION_REASON_CODES,
  type AcceptCheckExceptionInput,
} from "@pharmax/compliance";

import { dispatchOpsCommand } from "../../../../../../../../src/server/ops/dispatch-from-route.js";
import { getCheckCodeById } from "../../../../../../../../src/server/compliance/resolve-codes.js";

interface RouteParams {
  readonly params: Promise<{ readonly checkId: string }>;
}

type ExceptionReasonCode = (typeof COMPLIANCE_EXCEPTION_REASON_CODES)[number];

function readString(body: FormData | Record<string, unknown>, key: string): string | null {
  if (body instanceof FormData) {
    const v = body.get(key);
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readInt(body: FormData | Record<string, unknown>, key: string): number | null {
  const raw = body instanceof FormData ? body.get(key) : (body as Record<string, unknown>)[key];
  const parsed = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { checkId } = await context.params;
  const back = `/ops/admin/compliance/checks/${checkId}`;

  return await dispatchOpsCommand({
    request,
    command: AcceptCheckException,
    idempotencyKeyPrefix: `route:compliance-accept-exception:${checkId}`,
    buildInput: async ({ body }) => {
      const reasonRaw = readString(body, "reasonCode");
      const justification = readString(body, "justification");
      const durationDays = readInt(body, "durationDays");

      if (
        reasonRaw === null ||
        !(COMPLIANCE_EXCEPTION_REASON_CODES as ReadonlyArray<string>).includes(reasonRaw)
      ) {
        return {
          error: `reasonCode must be one of: ${COMPLIANCE_EXCEPTION_REASON_CODES.join(", ")}.`,
        };
      }
      if (justification === null || justification.trim().length < 20) {
        return {
          error: "A justification of at least 20 characters is required. It is read in the audit.",
        };
      }
      if (
        durationDays === null ||
        durationDays < 1 ||
        durationDays > COMPLIANCE_EXCEPTION_MAX_DAYS
      ) {
        return { error: `durationDays must be between 1 and ${COMPLIANCE_EXCEPTION_MAX_DAYS}.` };
      }

      // Resolved from the trusted URL, never from the posted body.
      const checkCode = await getCheckCodeById(checkId);
      if (checkCode === null) {
        return { error: "That check no longer exists." };
      }

      const input: AcceptCheckExceptionInput = {
        checkCode,
        // Platform-wide. Narrowing an exception to a single tenant is
        // a real capability of the command, but it has no operator
        // surface yet — the checks page has no tenant picker, and
        // silently defaulting to the approver's own org would scope
        // exceptions somewhere nobody asked for.
        subjectOrganizationId: null,
        reasonCode: reasonRaw as ExceptionReasonCode,
        justification: justification.trim(),
        durationDays,
      };
      return input;
    },
    successRedirect: () => `${back}?flash=excepted`,
    failureRedirect: back,
    successLogEvent: "ops.compliance.exception.accept.applied",
    failureLogEvent: "ops.compliance.exception.accept.failed",
  });
}
