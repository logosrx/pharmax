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
import { withSentryOpsScope } from "../observability/ops-scope.js";
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
  /**
   * Optional best-effort hook fired AFTER the command commits
   * successfully, BEFORE the success redirect. Use for post-commit
   * side effects that are not part of the command's transaction —
   * notably cache invalidation (e.g. dropping the operator-permission
   * cache after a role change). Runs in the operator's resolved org.
   *
   * A throw is caught + logged and does NOT convert a successful
   * command into a failed request: the authoritative state already
   * committed, so the redirect must still reflect success.
   */
  readonly onSuccess?: (result: {
    readonly output: TOut;
    readonly organizationId: string;
    readonly operatorUserId: string;
  }) => Promise<void> | void;
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

  // `buildInput` and `resolveTenancyExtras` may issue org-scoped
  // reads (e.g. the print-vial-label route looks up the order's site
  // to validate the workstation). Those reads go through the
  // tenancy-enforced Prisma client, which fails closed when no ALS
  // frame is active. Run BOTH callbacks inside the operator's base
  // tenancy frame so their reads are auto-scoped to the operator's
  // org. The final command dispatch runs in its own (extras-enriched)
  // frame below.
  const prepared = await withTenancyContext(session.tenancy, async () => {
    const builtInner = await Promise.resolve(
      input.buildInput({
        body,
        operatorUserId: session.operator.userId,
        organizationId: session.tenancy.organizationId,
        bodyKind,
      })
    );
    if (builtInner !== null && typeof builtInner === "object" && "error" in builtInner) {
      return { kind: "error" as const, error: builtInner.error };
    }

    let extrasInner: DispatchOpsCommandTenancyExtras = {};
    if (input.resolveTenancyExtras !== undefined) {
      const extras = await input.resolveTenancyExtras({
        body,
        operatorUserId: session.operator.userId,
        organizationId: session.tenancy.organizationId,
      });
      if (extras !== null && extras !== undefined && "error" in extras) {
        return { kind: "error" as const, error: extras.error };
      }
      if (extras !== null && extras !== undefined) {
        extrasInner = extras;
      }
    }
    return { kind: "ok" as const, built: builtInner as TIn, tenancyExtras: extrasInner };
  });

  if (prepared.kind === "error") {
    return NextResponse.redirect(
      new URL(
        `${input.failureRedirect}?error=${encodeURIComponent(prepared.error)}`,
        "http://internal"
      ).toString(),
      { status: 303 }
    );
  }
  const built = prepared.built;
  const tenancyExtras = prepared.tenancyExtras;

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

  // Run the dispatch inside a Sentry scope frame so any error
  // captured by the logger-bridge inside this function gets
  // automatically tagged with the operator, the command name,
  // and the organization. Without this, Sentry events fire but
  // every event is "anonymous unscoped server error" — hard to
  // triage in the dashboard.
  return await withSentryOpsScope(
    {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      operatorDisplayName: session.operator.displayName,
      clerkUserId: session.operator.clerkUserId,
      commandName: input.command.name,
      route: input.idempotencyKeyPrefix,
    },
    async () => {
      try {
        const output = await withTenancyContext(tenancy, () =>
          executeCommand(input.command, built as TIn, { idempotencyKey })
        );
        logger.info(input.successLogEvent, { operatorUserId: session.operator.userId });
        if (input.onSuccess !== undefined) {
          // Best-effort post-commit side effect (e.g. cache
          // invalidation). The command already committed; a hook
          // failure must not turn success into an error redirect.
          try {
            await input.onSuccess({
              output,
              organizationId: session.tenancy.organizationId,
              operatorUserId: session.operator.userId,
            });
          } catch (hookCause) {
            logger.warn(`${input.successLogEvent}.on_success_failed`, {
              operatorUserId: session.operator.userId,
              commandName: input.command.name,
              error: hookCause,
            });
          }
        }
        return NextResponse.redirect(
          new URL(input.successRedirect(output), "http://internal").toString(),
          { status: 303 }
        );
      } catch (cause) {
        const code = cause instanceof errors.PharmaxError ? cause.code : "OPS_DISPATCH_FAILED";
        const message = cause instanceof errors.PharmaxError ? cause.message : "Unable to apply.";
        // Forward `cause` as `error` so the logger-bridge calls
        // Sentry.captureException (with stack) rather than
        // captureMessage (string only). The PHI-redaction
        // allowlist in `sentry-scrubber.ts` strips anything
        // unsafe before the event leaves the process.
        logger.error(input.failureLogEvent, {
          operatorUserId: session.operator.userId,
          commandName: input.command.name,
          code,
          error: cause,
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
  );
}
