// POST /api/ops/orders/:orderId/resolve-escalation
//
// Operator-driven disposition for an order in the EMERGENCY bucket.
// Consumed by the `/ops/emergency` page form (server-rendered POST,
// no client JS); will also be the entry point for any future
// programmatic operator tooling.
//
// Flow:
//
//   1. Resolve Clerk session → Pharmax TenancyContext.
//   2. Validate `disposition` + optional `reasonText` from the
//      form body (or JSON body, if a future client posts JSON).
//   3. Dispatch `ResolveOrderEscalation` through the standard
//      command bus inside the operator's tenancy. The command's
//      own RBAC gate enforces `ship.resolve_escalation`; the route
//      doesn't re-check.
//   4. Redirect back to `/ops/emergency` with a flash query param
//      (success → `?resolved=<orderId>`; failure → `?error=<msg>`).
//
// Idempotency:
//   - Per-request key: `route:resolve-escalation:{orderId}:{minute}`
//     (minute-bucketed so a double-click within a minute is a
//     no-op; cross-minute repeats hit the command's own
//     "not-in-EMERGENCY" guard).
//
// PHI: `reasonText` is operator-typed free-text and MAY contain
// PHI by accident. The command's `redactFields` declaration scrubs
// it from `command_log.requestPayload`; we never echo it back in
// the redirect (only the orderId).

import {
  ESCALATION_DISPOSITIONS,
  ResolveOrderEscalation,
  type EscalationDisposition,
} from "@pharmax/shipping";
import { errors, ids } from "@pharmax/platform-core";
import { executeCommand } from "@pharmax/command-bus";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../src/server/logger.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

function parseDisposition(value: unknown): EscalationDisposition | null {
  if (typeof value !== "string") return null;
  return ESCALATION_DISPOSITIONS.includes(value as EscalationDisposition)
    ? (value as EscalationDisposition)
    : null;
}

function redirectBack(searchParams: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/ops/emergency?${searchParams}`, "http://internal").toString(),
    { status: 303 }
  );
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;

  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return NextResponse.redirect(new URL("/sign-in", "http://internal").toString(), {
      status: 303,
    });
  }

  // Accept either form-encoded body (the on-page form) or JSON
  // (programmatic clients). Default to form-encoded.
  let disposition: string | null = null;
  let reasonText: string | undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    disposition = typeof body["disposition"] === "string" ? body["disposition"] : null;
    if (typeof body["reasonText"] === "string" && body["reasonText"].trim().length > 0) {
      reasonText = body["reasonText"].trim();
    }
  } else {
    const form = await request.formData();
    disposition = form.get("disposition")?.toString() ?? null;
    const raw = form.get("reasonText")?.toString() ?? "";
    if (raw.trim().length > 0) reasonText = raw.trim();
  }

  const parsedDisposition = parseDisposition(disposition);
  if (parsedDisposition === null) {
    return redirectBack(
      `error=${encodeURIComponent(
        `Invalid disposition. Expected one of: ${ESCALATION_DISPOSITIONS.join(", ")}.`
      )}`
    );
  }

  // Minute-bucketed idempotency: double-click within 60s is a no-op,
  // cross-minute repeats fall through to the command's own guard.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const idempotencyKey = `route:resolve-escalation:${orderId}:${parsedDisposition}:${minuteBucket}`;

  // Enter the operator's tenancy explicitly. The resolver returned
  // a TenancyContext; the dispatcher needs it on the AsyncLocalStorage
  // frame for RLS + audit + command_log.
  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  try {
    const out = await withTenancyContext(tenancy, () =>
      executeCommand(
        ResolveOrderEscalation,
        {
          orderId,
          disposition: parsedDisposition,
          ...(reasonText !== undefined ? { reasonText } : {}),
        },
        { idempotencyKey }
      )
    );
    logger.info("ops.emergency.resolved", {
      orderId,
      disposition: parsedDisposition,
      bucketUnchanged: out.bucketUnchanged,
      previousBucketId: out.previousBucketId,
      newBucketId: out.newBucketId,
      operatorUserId: session.operator.userId,
    });
    return redirectBack(`resolved=${encodeURIComponent(orderId)}`);
  } catch (cause) {
    const code =
      cause instanceof errors.PharmaxError ? cause.code : "OPS_RESOLVE_ESCALATION_FAILED";
    const message =
      cause instanceof errors.PharmaxError ? cause.message : "Unable to resolve escalation.";
    logger.error("ops.emergency.resolve_failed", {
      orderId,
      disposition: parsedDisposition,
      code,
      operatorUserId: session.operator.userId,
    });
    return redirectBack(`error=${encodeURIComponent(`${code}: ${message}`)}`);
  }
}
