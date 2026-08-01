// Bearer token → ApiKey row resolution (ADR-0032).
//
// Mirrors the session engine: the bearer token arrives BEFORE the
// platform knows which tenant it belongs to, so the unique-indexed
// `tokenHash` lookup runs in a system-context frame. Everything
// downstream (v1 reads, command dispatches) then executes inside
// the RESOLVED org's tenancy — this module is the only pre-tenant
// step on the partner path.
//
// `lastUsedAt` is bumped best-effort, throttled to once per minute
// per key, so the hot read path does not write on every request.
//
// PHI: none. Key metadata only.

import type { ApiKeyQuotaTier, PrismaClient } from "@pharmax/database";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

import { hashApiKeyToken, isWellFormedApiKeyToken } from "./token.js";

export const RESOLVE_API_KEY_MALFORMED = "RESOLVE_API_KEY_MALFORMED";
export const RESOLVE_API_KEY_NOT_FOUND = "RESOLVE_API_KEY_NOT_FOUND";
export const RESOLVE_API_KEY_REVOKED = "RESOLVE_API_KEY_REVOKED";

export type ResolveApiKeyFailure =
  | typeof RESOLVE_API_KEY_MALFORMED
  | typeof RESOLVE_API_KEY_NOT_FOUND
  | typeof RESOLVE_API_KEY_REVOKED;

export interface ResolvedApiKey {
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scopes: ReadonlyArray<string>;
  /** Named quota tier — resolved to actual limits via `getApiKeyQuota`. */
  readonly quotaTier: ApiKeyQuotaTier;
  /** The operator the key acts on behalf of (its minter). */
  readonly createdByUserId: string;
}

export type ResolveApiKeyResult =
  | { readonly ok: true; readonly key: ResolvedApiKey }
  | { readonly ok: false; readonly reason: ResolveApiKeyFailure };

const LAST_USED_THROTTLE_MS = 60_000;

export type ResolveApiKeyClient = Pick<PrismaClient, "$transaction">;

export async function resolveApiKey(input: {
  readonly rawToken: string;
  readonly client: ResolveApiKeyClient;
  readonly clock?: () => Date;
}): Promise<ResolveApiKeyResult> {
  if (!isWellFormedApiKeyToken(input.rawToken)) {
    return Object.freeze({ ok: false, reason: RESOLVE_API_KEY_MALFORMED });
  }

  const tokenHash = hashApiKeyToken(input.rawToken);
  const now = (input.clock ?? (() => new Date()))();
  const reason = "@pharmax/partner-api:resolve-api-key";

  const row = await withSystemContext(reason, () =>
    input.client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, reason);
      const found = await tx.apiKey.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          organizationId: true,
          name: true,
          tokenPrefix: true,
          scopes: true,
          quotaTier: true,
          status: true,
          lastUsedAt: true,
          createdByUserId: true,
        },
      });
      if (found === null || found.status !== "ACTIVE") {
        return found;
      }
      if (
        found.lastUsedAt === null ||
        now.getTime() - found.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS
      ) {
        await tx.apiKey.update({
          where: { id: found.id },
          data: { lastUsedAt: now },
          select: { id: true },
        });
      }
      return found;
    })
  );

  if (row === null) {
    return Object.freeze({ ok: false, reason: RESOLVE_API_KEY_NOT_FOUND });
  }
  if (row.status !== "ACTIVE") {
    return Object.freeze({ ok: false, reason: RESOLVE_API_KEY_REVOKED });
  }

  return Object.freeze({
    ok: true,
    key: Object.freeze({
      apiKeyId: row.id,
      organizationId: row.organizationId,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      scopes: Object.freeze([...row.scopes]),
      quotaTier: row.quotaTier,
      createdByUserId: row.createdByUserId,
    }),
  });
}
