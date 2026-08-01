// POST /api/ops/admin/api-keys/create — mint a partner API key
// (ADR-0032). JSON in, JSON out.
//
// This route is hand-rolled (not `dispatchOpsCommandWithMfa`) because
// the response contract is different from every other admin write:
// the raw `pxk_` token is generated HERE at the transport layer and
// returned in the JSON body exactly once. Only its SHA-256 hash
// crosses into the command bus, so neither command_log nor the
// idempotency response cache can ever reproduce the secret — which
// also means a redirect+flash flow physically cannot deliver it.
//
// Idempotency: the caller supplies an `Idempotency-Key` header
// (namespaced per operator). A retry replays the stored key's
// metadata WITHOUT minting a second key — and WITHOUT a token,
// because the raw token never crosses the bus: the response was
// lost, the secret with it, and the recovery path is revoke +
// re-mint. The command declares `hashExcludeFields` for the
// per-attempt tokenHash/tokenPrefix so the replay matches.
//
// Gates (in order): operator session → MFA floor → command bus
// (RBAC `api.keys.manage`, idempotency, audit, outbox).
//
// PHI: none.

import { executeCommandDetailed } from "@pharmax/command-bus";
import {
  API_KEY_QUOTA_TIER_NAMES,
  CreateApiKey,
  generateApiKeyToken,
  isApiKeyQuotaTier,
} from "@pharmax/partner-api";
import { errors, ids } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { loadOperatorRoleCodes } from "../../../../../../src/server/auth/load-operator-role-codes.js";
import { enforceOperatorMfa, MFA_REQUIRED } from "../../../../../../src/server/auth/require-mfa.js";
import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../src/server/logger.js";
import { withSentryOpsScope } from "../../../../../../src/server/observability/ops-scope.js";

function jsonError(status: number, code: string, message: string): Response {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return jsonError(401, "UNAUTHENTICATED", "Operator session required.");
  }

  const roleCodes = await loadOperatorRoleCodes({
    organizationId: session.tenancy.organizationId,
    userId: session.tenancy.actor.userId,
  });
  try {
    enforceOperatorMfa({
      userId: session.operator.userId,
      roleCodes,
      mfaSatisfied: session.operator.mfaSatisfied,
    });
  } catch (cause) {
    if (cause instanceof errors.AuthorizationError && cause.code === MFA_REQUIRED) {
      logger.warn("ops.admin.api_key.create.mfa_denied", {
        operatorUserId: session.operator.userId,
        organizationId: session.tenancy.organizationId,
      });
      return jsonError(
        403,
        MFA_REQUIRED,
        "Multi-factor authentication is required for this action."
      );
    }
    throw cause;
  }

  // Same header contract as v1 partner mutations (ADR-0032): the
  // CALLER owns the retry boundary. Deriving the key from anything
  // generated server-side per attempt (the old tokenHash scheme)
  // makes a retry mint a second live key.
  const idempotencyHeader = (request.headers.get("idempotency-key") ?? "").trim();
  if (idempotencyHeader.length < 8 || idempotencyHeader.length > 200) {
    return jsonError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Minting an API key requires an `Idempotency-Key` header (8-200 characters)."
    );
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (name.length === 0) {
    return jsonError(400, "NAME_REQUIRED", "name is required.");
  }
  const scopes = Array.isArray(body["scopes"]) ? body["scopes"] : null;
  if (scopes === null || scopes.length === 0) {
    return jsonError(400, "SCOPES_REQUIRED", "scopes must be a non-empty array.");
  }
  // Optional named quota tier (ADR-0032); omitted ⇒ STANDARD.
  const rawTier = body["quotaTier"];
  if (rawTier !== undefined && !isApiKeyQuotaTier(rawTier)) {
    return jsonError(
      400,
      "QUOTA_TIER_INVALID",
      `quotaTier must be one of: ${API_KEY_QUOTA_TIER_NAMES.join(", ")}.`
    );
  }

  // The raw token exists only in this stack frame and the response.
  const generated = generateApiKeyToken();

  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  return await withSentryOpsScope(
    {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      operatorDisplayName: session.operator.displayName,
      commandName: CreateApiKey.name,
      route: "route:create-api-key",
    },
    async () => {
      try {
        const { output, replayed } = await withTenancyContext(tenancy, () =>
          executeCommandDetailed(
            CreateApiKey,
            {
              name,
              tokenHash: generated.tokenHash,
              tokenPrefix: generated.tokenPrefix,
              scopes,
              ...(rawTier !== undefined ? { quotaTier: rawTier } : {}),
            },
            // Caller-owned retry boundary, namespaced per operator so
            // two operators reusing the same header value never
            // collide (the bus already namespaces per org + command).
            {
              idempotencyKey: `route:create-api-key:${session.operator.userId}:${idempotencyHeader}`,
            }
          )
        );
        if (replayed) {
          // The stored key is NOT the one generated in this stack
          // frame — the fresh token is discarded, and the original
          // raw token is unrecoverable by design. No second key was
          // minted; the operator should revoke + re-mint if the
          // first response never arrived.
          logger.info("ops.admin.api_key.create.replayed", {
            operatorUserId: session.operator.userId,
            apiKeyId: output.apiKeyId,
            tokenPrefix: output.tokenPrefix,
          });
          return NextResponse.json(
            {
              data: {
                apiKeyId: output.apiKeyId,
                name: output.name,
                tokenPrefix: output.tokenPrefix,
                scopes: output.scopes,
                quotaTier: output.quotaTier,
                // Only available on FIRST creation. Revoke + re-mint
                // if the original response was lost.
                token: null,
              },
              meta: { idempotentReplay: true },
            },
            { status: 200 }
          );
        }
        logger.info("ops.admin.api_key.create.applied", {
          operatorUserId: session.operator.userId,
          apiKeyId: output.apiKeyId,
          tokenPrefix: output.tokenPrefix,
        });
        return NextResponse.json(
          {
            data: {
              apiKeyId: output.apiKeyId,
              name: output.name,
              tokenPrefix: output.tokenPrefix,
              scopes: output.scopes,
              quotaTier: output.quotaTier,
              // Shown exactly once; not recoverable after this response.
              token: generated.token,
            },
          },
          { status: 201 }
        );
      } catch (cause) {
        const code = cause instanceof errors.PharmaxError ? cause.code : "OPS_DISPATCH_FAILED";
        const message =
          cause instanceof errors.PharmaxError ? cause.message : "Unable to create API key.";
        logger.error("ops.admin.api_key.create.failed", {
          operatorUserId: session.operator.userId,
          code,
          error: cause,
        });
        return jsonError(422, code, message);
      }
    }
  );
}
