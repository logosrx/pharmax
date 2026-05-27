// Clerk webhook event handlers.
//
// The transport-layer route (`/api/webhooks/clerk/route.ts`) verifies
// the Svix signature against raw bytes, dedupes on `svix-id` against
// the `clerk_webhook_event` ledger, parses the JSON, and hands the
// typed event to `dispatchClerkWebhookEvent` below. All side-effects
// (Pharmax DB writes, audit_log) happen here.
//
// Event types we care about (Clerk publishes many; we subscribe to
// the minimum required set):
//
//   - `user.created`   — Clerk identity created. Look for a matching
//     INVITED `user` row by primary email; if found and unique,
//     link `clerkUserId` and flip status to ACTIVE. If no matching
//     INVITED row exists, NO-OP — Pharmax is invitation-only; a Clerk
//     identity without a corresponding INVITED row is a noise event
//     (e.g. a stray sign-up that the proxy didn't block in time).
//
//   - `user.updated`   — Primary email or name changed in Clerk.
//     Sync to the local `user` row keyed by `clerkUserId`. We never
//     create a row in this path; only update an existing link.
//
//   - `user.deleted`   — Clerk identity removed. Flip the linked
//     Pharmax row to TERMINATED (we do NOT delete: HIPAA + SOC 2
//     require us to retain the identity history for the lifetime of
//     any audit log entry referencing it). Clear `clerkUserId` so a
//     future Clerk identity with the same email cannot accidentally
//     re-link to a terminated row.
//
//   - `session.created` — Operator started a new session. We use this
//     ONLY as a place to capture a structured "operator signed in"
//     audit event; we do not mutate user state. The MFA-required
//     gate is enforced at request time in `require-mfa.ts` so this
//     handler stays a pure signal-emitter.
//
// Trust boundary:
//
//   The HTTP transport has already (a) verified the Svix signature
//   over the raw request bytes and (b) deduped on `svix-id`. By the
//   time `dispatchClerkWebhookEvent` runs, the event is authentic
//   and not a replay. Idempotency at THIS layer is still enforced
//   structurally (link/sync/terminate are guarded updates) — defence
//   in depth, in case the transport-layer dedupe ever has a hole.
//
// Audit invariant:
//
//   Every state-changing outcome (link / sync / terminate, plus the
//   refused-relink security event) writes a chain-linked audit_log
//   entry inside the same transaction as the user mutation. The
//   `session.created` signal also writes audit_log (no mutation).
//   Idempotent re-deliveries that no-op do NOT emit audit; the
//   svix-id ledger already records the receipt and an audit row per
//   redelivery would inflate the chain without information.
//
// PHI invariant: Clerk events do not carry PHI. The fields we read —
// id, email, names — are operator identity, not patient data. The
// audit_log metadata mirrors that scope.

import "server-only";

import { writeAuditLogInTx, type AuditChainTxClient } from "@pharmax/audit";
import { prisma, UserStatus, type PrismaClient } from "@pharmax/database";
import { applySystemSessionGuc, withSystemContext } from "@pharmax/tenancy";

import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Typed event payloads (narrow surface — Clerk publishes more fields
// than we read; the schemas below capture only what we depend on).
// ---------------------------------------------------------------------------

export interface ClerkEmailAddress {
  readonly id: string;
  readonly email_address: string;
}

export interface ClerkUserPayload {
  readonly id: string;
  readonly primary_email_address_id: string | null;
  readonly email_addresses: ReadonlyArray<ClerkEmailAddress>;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly username: string | null;
}

export interface ClerkSessionPayload {
  readonly id: string;
  readonly user_id: string;
  readonly status: string;
}

export interface ClerkWebhookEvent {
  readonly type: string;
  readonly data: unknown;
}

// ---------------------------------------------------------------------------
// Dispatcher.
// ---------------------------------------------------------------------------

export type DispatchOutcome =
  | "applied"
  | "noop_no_invited_row"
  | "noop_no_link"
  | "noop_unknown_event"
  | "noop_session_signal_only"
  | "noop_link_refused";

/**
 * Minimal shape of a Prisma transaction client we rely on. Equals
 * `Prisma.TransactionClient` structurally; redeclared here so the
 * apps/web tier doesn't reach into the @pharmax/database internals
 * for types it consumes only structurally.
 */
export interface ClerkWebhookTxClient {
  readonly $executeRaw: (
    template: TemplateStringsArray,
    ...values: ReadonlyArray<unknown>
  ) => Promise<number>;
  readonly user: {
    readonly findUnique: PrismaClient["user"]["findUnique"];
    readonly findMany: PrismaClient["user"]["findMany"];
    readonly update: PrismaClient["user"]["update"];
  };
  readonly auditLog: PrismaClient["auditLog"];
  readonly auditChainState: PrismaClient["auditChainState"];
}

/**
 * Hooks injection. Every external dependency is overridable so the
 * unit-test suite runs offline (no Postgres, no Clerk) AND so the
 * production wiring can be swapped for a different audit chain
 * implementation without touching this file.
 */
export interface DispatchOptions {
  /** Prisma client; defaults to the singleton. */
  readonly client?: PrismaClient;
  /**
   * Open an interactive transaction. Default delegates to
   * `client.$transaction`. Tests typically pass `(c, fn) => fn(c)`
   * so the body executes against the test's hand-rolled client
   * without spawning a real transaction.
   */
  readonly runInTransaction?: TxRunner;
  /**
   * Set the RLS BYPASSRLS sentinel + clear tenant pin on the tx
   * connection. Default delegates to
   * `applySystemSessionGuc(tx, "clerk.webhook")`. Tests pass a no-op.
   *
   * NOTE: this MUST run inside the transaction body — `set_config`
   * with `is_local=true` is connection-scoped. Calling it on a
   * non-tx pool client would set the GUC on a random connection
   * and lose it on the next checkout.
   */
  readonly applySystemGuc?: (tx: ClerkWebhookTxClient, reason: string) => Promise<void>;
  /**
   * Write an audit_log row + advance the per-tenant chain head.
   * Default delegates to `writeAuditLogInTx`. Tests inject a spy
   * to assert the audit shape per outcome.
   */
  readonly writeAudit?: AuditEntryWriter;
}

export type TxRunner = <T>(
  client: PrismaClient,
  body: (tx: ClerkWebhookTxClient) => Promise<T>
) => Promise<T>;

export interface ClerkAuditEntry {
  readonly organizationId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly actorUserId: string | null;
  readonly scope: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly occurredAt: Date;
}

export type AuditEntryWriter = (tx: ClerkWebhookTxClient, entry: ClerkAuditEntry) => Promise<void>;

const SYSTEM_REASON = "clerk.webhook";
const RESOURCE_TYPE_USER = "User";
const RESOURCE_TYPE_SESSION = "ClerkSession";

export async function dispatchClerkWebhookEvent(
  event: ClerkWebhookEvent,
  options: DispatchOptions = {}
): Promise<DispatchOutcome> {
  const deps = resolveDeps(options);

  switch (event.type) {
    case "user.created": {
      const payload = parseUserPayload(event.data);
      if (payload === null) return "noop_no_invited_row";
      return handleUserCreated(payload, deps);
    }
    case "user.updated": {
      const payload = parseUserPayload(event.data);
      if (payload === null) return "noop_no_link";
      return handleUserUpdated(payload, deps);
    }
    case "user.deleted": {
      const payload = parseDeletedPayload(event.data);
      if (payload === null) return "noop_no_link";
      return handleUserDeleted(payload, deps);
    }
    case "session.created": {
      const payload = parseSessionPayload(event.data);
      if (payload === null) return "noop_session_signal_only";
      return handleSessionCreated(payload, deps);
    }
    default:
      logger.info("clerk.webhook.event_ignored", {
        event: "clerk.webhook.event_ignored",
        eventType: event.type,
      });
      return "noop_unknown_event";
  }
}

interface ResolvedDeps {
  readonly client: PrismaClient;
  readonly runInTransaction: TxRunner;
  readonly applySystemGuc: (tx: ClerkWebhookTxClient, reason: string) => Promise<void>;
  readonly writeAudit: AuditEntryWriter;
}

function resolveDeps(options: DispatchOptions): ResolvedDeps {
  const client = options.client ?? prisma;
  return {
    client,
    runInTransaction: options.runInTransaction ?? defaultTxRunner,
    applySystemGuc: options.applySystemGuc ?? defaultApplySystemGuc,
    writeAudit: options.writeAudit ?? defaultWriteAudit,
  };
}

const defaultTxRunner: TxRunner = (client, body) =>
  client.$transaction(async (tx) => body(tx as unknown as ClerkWebhookTxClient));

async function defaultApplySystemGuc(tx: ClerkWebhookTxClient, reason: string): Promise<void> {
  await applySystemSessionGuc(tx, reason);
}

const defaultWriteAudit: AuditEntryWriter = async (tx, entry) => {
  await writeAuditLogInTx(tx as unknown as AuditChainTxClient, {
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    scope: entry.scope,
    metadata: entry.metadata,
    occurredAt: entry.occurredAt,
  });
};

// ---------------------------------------------------------------------------
// Payload parsing.
// ---------------------------------------------------------------------------

function parseUserPayload(data: unknown): ClerkUserPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const v = data as Record<string, unknown>;
  if (typeof v.id !== "string") return null;
  if (!Array.isArray(v.email_addresses)) return null;
  const emailAddresses: ClerkEmailAddress[] = [];
  for (const entry of v.email_addresses) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id === "string" && typeof e.email_address === "string") {
      emailAddresses.push({ id: e.id, email_address: e.email_address });
    }
  }
  return {
    id: v.id,
    primary_email_address_id:
      typeof v.primary_email_address_id === "string" ? v.primary_email_address_id : null,
    email_addresses: emailAddresses,
    first_name: typeof v.first_name === "string" ? v.first_name : null,
    last_name: typeof v.last_name === "string" ? v.last_name : null,
    username: typeof v.username === "string" ? v.username : null,
  };
}

function parseDeletedPayload(data: unknown): { readonly id: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const v = data as Record<string, unknown>;
  if (typeof v.id !== "string") return null;
  return { id: v.id };
}

function parseSessionPayload(data: unknown): ClerkSessionPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const v = data as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.user_id !== "string") return null;
  return {
    id: v.id,
    user_id: v.user_id,
    status: typeof v.status === "string" ? v.status : "unknown",
  };
}

// ---------------------------------------------------------------------------
// user.created — auto-link to an INVITED row.
// ---------------------------------------------------------------------------

async function handleUserCreated(
  payload: ClerkUserPayload,
  deps: ResolvedDeps
): Promise<DispatchOutcome> {
  const email = extractPrimaryEmail(payload);
  if (email === null) {
    logger.warn("clerk.webhook.user_created.no_primary_email", {
      event: "clerk.webhook.user_created.no_primary_email",
      clerkUserId: payload.id,
    });
    return "noop_no_invited_row";
  }

  return withSystemContext("clerk.webhook.user_created", async () => {
    // Cross-tenant read: a Clerk identity is tenant-less until we
    // resolve it to a Pharmax `user` row. Same shape as the worker
    // drains' webhook resolvers (see ESLint Override 3c).
    const candidates = await deps.client.user.findMany({
      where: { email, status: UserStatus.INVITED },
      select: { id: true, organizationId: true, email: true, clerkUserId: true },
    });

    if (candidates.length === 0) {
      // Pharmax is invitation-only. A Clerk identity without a
      // matching INVITED row is most likely a stray sign-up that
      // slipped through; ignore. The operator will see
      // RESOLVE_TENANCY_USER_NOT_LINKED when they try to use the
      // app, which is the right UX (we don't auto-provision).
      logger.info("clerk.webhook.user_created.no_invited_row", {
        event: "clerk.webhook.user_created.no_invited_row",
        clerkUserId: payload.id,
        email,
      });
      return "noop_no_invited_row";
    }

    if (candidates.length > 1) {
      // Configuration error: multiple INVITED rows across orgs share
      // the same email. We refuse to guess which org the operator
      // belongs to. Surface loudly; an admin needs to deduplicate.
      logger.warn("clerk.webhook.user_created.ambiguous_invite", {
        event: "clerk.webhook.user_created.ambiguous_invite",
        clerkUserId: payload.id,
        email,
        candidateCount: candidates.length,
      });
      return "noop_no_invited_row";
    }

    const target = candidates[0]!;
    if (target.clerkUserId !== null && target.clerkUserId !== payload.id) {
      // Row already linked to a different Clerk identity. Refuse to
      // re-link silently — this is the "stolen identity / takeover"
      // path. Operator must contact admin. Audit it as a security
      // event (the chain entry IS the evidence).
      logger.warn("clerk.webhook.user_created.already_linked_elsewhere", {
        event: "clerk.webhook.user_created.already_linked_elsewhere",
        clerkUserId: payload.id,
        email,
        existingClerkUserId: target.clerkUserId,
        userId: target.id,
      });
      await runAuditOnly(deps, {
        organizationId: target.organizationId,
        action: "auth.clerk.user_link_refused",
        resourceType: RESOURCE_TYPE_USER,
        resourceId: target.id,
        actorUserId: null,
        scope: { organizationId: target.organizationId },
        metadata: {
          incomingClerkUserId: payload.id,
          existingClerkUserId: target.clerkUserId,
          // Email is operator identity, not PHI. Safe to record.
          email,
        },
        occurredAt: new Date(),
      });
      return "noop_link_refused";
    }

    // Idempotent re-delivery: if the row is already linked to THIS
    // Clerk identity AND already ACTIVE, no state changes. Suppress
    // the audit emission so chain growth stays proportional to
    // real lifecycle events.
    const displayName = composeDisplayName(payload);

    return await deps.runInTransaction(deps.client, async (tx) => {
      await deps.applySystemGuc(tx, SYSTEM_REASON);

      await tx.user.update({
        where: { id: target.id },
        data: {
          clerkUserId: payload.id,
          status: UserStatus.ACTIVE,
          ...(displayName !== null ? { displayName } : {}),
        },
      });

      await deps.writeAudit(tx, {
        organizationId: target.organizationId,
        action: "auth.clerk.user_linked",
        resourceType: RESOURCE_TYPE_USER,
        resourceId: target.id,
        actorUserId: null,
        scope: { organizationId: target.organizationId },
        metadata: {
          clerkUserId: payload.id,
          email,
          ...(displayName !== null ? { displayName } : {}),
        },
        occurredAt: new Date(),
      });

      logger.info("clerk.webhook.user_created.linked", {
        event: "clerk.webhook.user_created.linked",
        userId: target.id,
        organizationId: target.organizationId,
        clerkUserId: payload.id,
      });
      return "applied" as DispatchOutcome;
    });
  });
}

// ---------------------------------------------------------------------------
// user.updated — sync email + displayName to the local row.
// ---------------------------------------------------------------------------

async function handleUserUpdated(
  payload: ClerkUserPayload,
  deps: ResolvedDeps
): Promise<DispatchOutcome> {
  return withSystemContext("clerk.webhook.user_updated", async () => {
    const target = await deps.client.user.findUnique({
      where: { clerkUserId: payload.id },
      select: { id: true, organizationId: true, email: true, displayName: true },
    });
    if (target === null) {
      logger.info("clerk.webhook.user_updated.no_link", {
        event: "clerk.webhook.user_updated.no_link",
        clerkUserId: payload.id,
      });
      return "noop_no_link";
    }

    const email = extractPrimaryEmail(payload);
    const displayName = composeDisplayName(payload);

    const updates: { email?: string; displayName?: string } = {};
    if (email !== null && email !== target.email) {
      updates.email = email;
    }
    if (displayName !== null && displayName !== target.displayName) {
      updates.displayName = displayName;
    }
    if (Object.keys(updates).length === 0) {
      // Idempotent re-delivery / no-op update from Clerk. No state
      // change → no audit emission.
      return "noop_no_link";
    }

    return await deps.runInTransaction(deps.client, async (tx) => {
      await deps.applySystemGuc(tx, SYSTEM_REASON);

      await tx.user.update({ where: { id: target.id }, data: updates });

      await deps.writeAudit(tx, {
        organizationId: target.organizationId,
        action: "auth.clerk.user_synced",
        resourceType: RESOURCE_TYPE_USER,
        resourceId: target.id,
        actorUserId: null,
        scope: { organizationId: target.organizationId },
        metadata: {
          clerkUserId: payload.id,
          changedFields: Object.keys(updates),
          ...(updates.email !== undefined ? { email: updates.email } : {}),
          ...(updates.displayName !== undefined ? { displayName: updates.displayName } : {}),
        },
        occurredAt: new Date(),
      });

      logger.info("clerk.webhook.user_updated.synced", {
        event: "clerk.webhook.user_updated.synced",
        userId: target.id,
        clerkUserId: payload.id,
        changedFields: Object.keys(updates),
      });
      return "applied" as DispatchOutcome;
    });
  });
}

// ---------------------------------------------------------------------------
// user.deleted — TERMINATE the linked row (do NOT delete: HIPAA + SOC 2
// require us to retain the identity for the lifetime of any audit_log
// entry that references it).
// ---------------------------------------------------------------------------

async function handleUserDeleted(
  payload: { readonly id: string },
  deps: ResolvedDeps
): Promise<DispatchOutcome> {
  return withSystemContext("clerk.webhook.user_deleted", async () => {
    const target = await deps.client.user.findUnique({
      where: { clerkUserId: payload.id },
      select: { id: true, status: true, organizationId: true },
    });
    if (target === null) {
      logger.info("clerk.webhook.user_deleted.no_link", {
        event: "clerk.webhook.user_deleted.no_link",
        clerkUserId: payload.id,
      });
      return "noop_no_link";
    }

    if (target.status === UserStatus.TERMINATED) {
      // Already terminated. Idempotent re-delivery; just clear the
      // clerkUserId if it's still set so the row is fully detached.
      // No audit emission on the second + delivery (the first
      // termination already wrote a chain entry).
      return await deps.runInTransaction(deps.client, async (tx) => {
        await deps.applySystemGuc(tx, SYSTEM_REASON);
        await tx.user.update({
          where: { id: target.id },
          data: { clerkUserId: null },
        });
        return "applied" as DispatchOutcome;
      });
    }

    return await deps.runInTransaction(deps.client, async (tx) => {
      await deps.applySystemGuc(tx, SYSTEM_REASON);

      await tx.user.update({
        where: { id: target.id },
        data: { status: UserStatus.TERMINATED, clerkUserId: null },
      });

      await deps.writeAudit(tx, {
        organizationId: target.organizationId,
        action: "auth.clerk.user_terminated",
        resourceType: RESOURCE_TYPE_USER,
        resourceId: target.id,
        actorUserId: null,
        scope: { organizationId: target.organizationId },
        metadata: {
          clerkUserId: payload.id,
          previousStatus: target.status,
        },
        occurredAt: new Date(),
      });

      logger.info("clerk.webhook.user_deleted.terminated", {
        event: "clerk.webhook.user_deleted.terminated",
        userId: target.id,
        organizationId: target.organizationId,
        clerkUserId: payload.id,
      });
      return "applied" as DispatchOutcome;
    });
  });
}

// ---------------------------------------------------------------------------
// session.created — non-mutating audit signal.
// ---------------------------------------------------------------------------

async function handleSessionCreated(
  payload: ClerkSessionPayload,
  deps: ResolvedDeps
): Promise<DispatchOutcome> {
  return withSystemContext<DispatchOutcome>(
    "clerk.webhook.session_created",
    async (): Promise<DispatchOutcome> => {
      const target = await deps.client.user.findUnique({
        where: { clerkUserId: payload.user_id },
        select: { id: true, organizationId: true, status: true },
      });
      if (target === null) {
        // Session created for a Clerk user not linked to any Pharmax
        // row. Could be a stray identity that signed in but never had
        // an INVITED row. No audit chain to write to (no org scope).
        logger.info("clerk.webhook.session_created.no_link", {
          event: "clerk.webhook.session_created.no_link",
          clerkUserId: payload.user_id,
          sessionId: payload.id,
        });
        return "noop_session_signal_only";
      }

      await runAuditOnly(deps, {
        organizationId: target.organizationId,
        action: "auth.clerk.session_created",
        resourceType: RESOURCE_TYPE_SESSION,
        resourceId: payload.id,
        actorUserId: target.id,
        scope: { organizationId: target.organizationId },
        metadata: {
          clerkUserId: payload.user_id,
          clerkSessionId: payload.id,
          sessionStatus: payload.status,
          userStatus: target.status,
        },
        occurredAt: new Date(),
      });

      logger.info("clerk.webhook.session_created.audited", {
        event: "clerk.webhook.session_created.audited",
        userId: target.id,
        organizationId: target.organizationId,
        clerkUserId: payload.user_id,
        sessionId: payload.id,
      });
      return "noop_session_signal_only";
    }
  );
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function runAuditOnly(deps: ResolvedDeps, entry: ClerkAuditEntry): Promise<void> {
  await deps.runInTransaction(deps.client, async (tx) => {
    await deps.applySystemGuc(tx, SYSTEM_REASON);
    await deps.writeAudit(tx, entry);
  });
}

function extractPrimaryEmail(payload: ClerkUserPayload): string | null {
  const primaryId = payload.primary_email_address_id;
  if (primaryId !== null && primaryId.length > 0) {
    const primary = payload.email_addresses.find((e) => e.id === primaryId);
    if (primary !== undefined) return normalizeEmail(primary.email_address);
  }
  const first = payload.email_addresses[0];
  if (first === undefined) return null;
  return normalizeEmail(first.email_address);
}

/** Lower-case + trim. The Pharmax `user.email` column is stored
 *  normalized at invite time (see `InviteUser`); matching MUST use
 *  the same normalization or a `john@acme.test` invitation will
 *  miss a `JOHN@acme.test` Clerk identity.
 */
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function composeDisplayName(payload: ClerkUserPayload): string | null {
  const parts = [payload.first_name, payload.last_name]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length > 0) return parts.join(" ");
  if (typeof payload.username === "string" && payload.username.trim().length > 0) {
    return payload.username.trim();
  }
  return null;
}
