// Shared shape for operator-driven HTTP route handlers that
// dispatch a single domain command.
//
// All three billing routes (finalize / credit / refund) and the
// emergency-resolve route follow the same skeleton:
//
//   1. Resolve Clerk session → Pharmax TenancyContext.
//   2. Parse form/JSON body.
//   3. Build a per-request idempotency key (minute-bucketed).
//   4. Enter tenancy.
//   5. Dispatch command.
//   6. Redirect with `?flash=<key>=<value>` flash params.
//
// This helper centralizes steps 1, 3, 4, 6 so each route is just
// "parse body + which command + which redirect target".

import "server-only";

import { executeCommand } from "@pharmax/command-bus";
import { errors, ids } from "@pharmax/platform-core";
import type { Command } from "@pharmax/command-bus";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { logger } from "../logger.js";
import { resolveOperatorTenancyContext } from "../auth/resolve-tenancy.js";

/**
 * Optional scope narrowers that the route can resolve from the
 * request body BEFORE building the tenancy. Use for commands that
 * declare `requiresWorkstation` or that need site-scoped audit
 * fields. Each field is independently optional.
 *
 * SECURITY: every value here MUST be authorization-checked by the
 * route — the operator can submit any UUID, so the route is
 * responsible for verifying the workstation / site belongs to the
 * operator's organization and is active. The helper just threads
 * the resolved value into the tenancy.
 */
export interface DispatchOpsCommandTenancyExtras {
  readonly workstationId?: string;
  readonly siteId?: string;
}

export interface DispatchOpsCommandInput<TIn, TOut> {
  readonly request: Request;
  readonly command: Command<TIn, TOut>;
  /** Build the command input from form/JSON body + the resolved operator session. */
  readonly buildInput: (input: {
    readonly body: FormData | Record<string, unknown>;
    readonly operatorUserId: string;
    readonly organizationId: string;
    readonly bodyKind: "form" | "json";
  }) => TIn | { readonly error: string } | Promise<TIn | { readonly error: string }>;
  /**
   * Optional resolver for additional tenancy scope. Runs after
   * `buildInput`. Return `{ error }` to short-circuit with a flash
   * error (typical: "workstation not found at this site"). Return
   * `null` to dispatch without enriching tenancy.
   */
  readonly resolveTenancyExtras?: (input: {
    readonly body: FormData | Record<string, unknown>;
    readonly operatorUserId: string;
    readonly organizationId: string;
  }) =>
    | Promise<DispatchOpsCommandTenancyExtras | { readonly error: string } | null>
    | DispatchOpsCommandTenancyExtras
    | { readonly error: string }
    | null;
  /** Stable per-request idempotency key prefix (e.g. `route:finalize-invoice:{id}`). */
  readonly idempotencyKeyPrefix: string;
  /** Redirect target on success. Receives the command's output for templating. */
  readonly successRedirect: (output: TOut) => string;
  /** Redirect target on failure (typed error code + message appended as `?error=`). */
  readonly failureRedirect: string;
  /** Logger event name on success. */
  readonly successLogEvent: string;
  /** Logger event name on failure. */
  readonly failureLogEvent: string;
}

export async function dispatchOpsCommand<TIn, TOut>(
  input: DispatchOpsCommandInput<TIn, TOut>
): Promise<Response> {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return NextResponse.redirect(new URL("/sign-in", "http://internal").toString(), {
      status: 303,
    });
  }

  const contentType = input.request.headers.get("content-type") ?? "";
  const bodyKind: "form" | "json" = contentType.includes("application/json") ? "json" : "form";
  const body: FormData | Record<string, unknown> =
    bodyKind === "json"
      ? ((await input.request.json().catch(() => ({}))) as Record<string, unknown>)
      : await input.request.formData();

  const built = await Promise.resolve(
    input.buildInput({
      body,
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      bodyKind,
    })
  );
  if (built !== null && typeof built === "object" && "error" in built) {
    return NextResponse.redirect(
      new URL(
        `${input.failureRedirect}?error=${encodeURIComponent(built.error)}`,
        "http://internal"
      ).toString(),
      { status: 303 }
    );
  }

  let tenancyExtras: DispatchOpsCommandTenancyExtras = {};
  if (input.resolveTenancyExtras !== undefined) {
    const extras = await input.resolveTenancyExtras({
      body,
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
    });
    if (extras !== null && extras !== undefined && "error" in extras) {
      return NextResponse.redirect(
        new URL(
          `${input.failureRedirect}?error=${encodeURIComponent(extras.error)}`,
          "http://internal"
        ).toString(),
        { status: 303 }
      );
    }
    if (extras !== null && extras !== undefined) {
      tenancyExtras = extras;
    }
  }

  const minuteBucket = Math.floor(Date.now() / 60_000);
  const idempotencyKey = `${input.idempotencyKeyPrefix}:${minuteBucket}`;

  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
    ...(tenancyExtras.workstationId !== undefined
      ? { workstationId: tenancyExtras.workstationId }
      : {}),
    ...(tenancyExtras.siteId !== undefined ? { siteId: tenancyExtras.siteId } : {}),
  });

  try {
    const output = await withTenancyContext(tenancy, () =>
      executeCommand(input.command, built as TIn, { idempotencyKey })
    );
    logger.info(input.successLogEvent, { operatorUserId: session.operator.userId });
    return NextResponse.redirect(
      new URL(input.successRedirect(output), "http://internal").toString(),
      { status: 303 }
    );
  } catch (cause) {
    const code = cause instanceof errors.PharmaxError ? cause.code : "OPS_DISPATCH_FAILED";
    const message = cause instanceof errors.PharmaxError ? cause.message : "Unable to apply.";
    logger.error(input.failureLogEvent, {
      operatorUserId: session.operator.userId,
      code,
    });
    return NextResponse.redirect(
      new URL(
        `${input.failureRedirect}?error=${encodeURIComponent(`${code}: ${message}`)}`,
        "http://internal"
      ).toString(),
      { status: 303 }
    );
  }
}
