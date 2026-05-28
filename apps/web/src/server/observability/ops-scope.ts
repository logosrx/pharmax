// Sentry scope helper for operator-initiated work.
//
// Every operator action — dispatched via /api/ops/* routes,
// rendered via /ops/* server components — runs server-side
// inside a Sentry scope frame. This helper pins ALL of:
//
//   - `user.id` = Pharmax operator user id (NOT Clerk id; the
//     Pharmax id is the canonical actor id everywhere else in
//     the audit chain, so dashboards stay joinable).
//   - `user.username` = operator displayName (PHI-safe; admin
//     display name, not patient identity).
//   - `tags.organizationId`, `tags.commandName`, `tags.route`,
//     `tags.surface` — the four filters a SOC 2 reviewer +
//     on-call engineer want most: by tenant, by command, by
//     route, by surface.
//   - `contexts.operator` — a structured operator block that
//     survives the scope and ends up on every event captured
//     inside it.
//
// PHI invariant: nothing in the scope is patient PHI. Operator
// id + displayName + email + Clerk id are admin identity, not
// patient data; the `sentry-scrubber.beforeSend` allowlist
// permits these explicitly. Patient ids, order ids,
// prescription ids, etc. are NOT placed on the scope here —
// they're allowed in event `extra` payloads case-by-case, but
// auto-tagging them would put them on every captured event
// inside the scope, which the PHI-redaction tests reject.
//
// Reporter-no-op safe: the helper imports `@sentry/nextjs`'s
// `withScope` directly. When Sentry is not initialized (no
// DSN, NODE_ENV=test), Sentry's `withScope` still runs the
// callback unconditionally and the scope mutations are no-ops.
// We don't gate on `initialized` here because that's an internal
// implementation detail of `sentry-init.ts`.

import "server-only";

import * as Sentry from "@sentry/nextjs";

export interface OpsScopeBindings {
  readonly operatorUserId: string;
  readonly organizationId: string;
  /** Display name — admin operator identity; PHI-safe. */
  readonly operatorDisplayName?: string;
  /** Clerk identity id; used as a join key for support tickets. */
  readonly clerkUserId?: string;
  /** Stable command name (e.g. "ApprovePV1", "UpdatePatient"). */
  readonly commandName?: string;
  /** Stable route (e.g. "POST /api/ops/orders/[orderId]/approve-pv1"). */
  readonly route?: string;
  /** Page or audit surface (e.g. "ORDER_DETAIL_PAGE"). */
  readonly surface?: string;
}

/**
 * Run `fn` inside a Sentry scope frame tagged with the operator
 * identity + the command / route bindings. Errors caught here
 * are NOT re-captured (the inner code is expected to call
 * `logger.error(..., { error: cause })` which the platform-core
 * error-reporter bridge forwards to Sentry); we re-throw so
 * existing catch logic in `dispatchOpsCommand` etc. continues to
 * produce the operator-facing flash error.
 */
export async function withSentryOpsScope<T>(
  bindings: OpsScopeBindings,
  fn: () => Promise<T>
): Promise<T> {
  return await Sentry.withScope(async (scope) => {
    scope.setUser({
      id: bindings.operatorUserId,
      ...(bindings.operatorDisplayName !== undefined
        ? { username: bindings.operatorDisplayName }
        : {}),
    });
    scope.setTag("organizationId", bindings.organizationId);
    if (bindings.commandName !== undefined) {
      scope.setTag("commandName", bindings.commandName);
    }
    if (bindings.route !== undefined) {
      scope.setTag("route", bindings.route);
    }
    if (bindings.surface !== undefined) {
      scope.setTag("surface", bindings.surface);
    }
    scope.setContext("operator", {
      userId: bindings.operatorUserId,
      organizationId: bindings.organizationId,
      ...(bindings.operatorDisplayName !== undefined
        ? { displayName: bindings.operatorDisplayName }
        : {}),
      ...(bindings.clerkUserId !== undefined ? { clerkUserId: bindings.clerkUserId } : {}),
    });
    return await fn();
  });
}
