// POST /api/ops/admin/api-keys/revoke — revoke a partner API key
// (ADR-0032). JSON in, JSON out (paired with the create route, which
// must be JSON to return the one-time token; the revoke side keeps
// the same call shape so one client can drive both).
//
// Gates: operator session → MFA floor → command bus (RBAC
// `api.keys.manage`, idempotency, audit, outbox). Resolution is
// immediate: `resolveApiKey` rejects REVOKED rows, so in-flight
// partner requests fail on their next call.

import { executeCommand } from "@pharmax/command-bus";
import { RevokeApiKey } from "@pharmax/partner-api";
import { errors, ids } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { loadOperatorRoleCodes } from "../../../../../../src/server/auth/load-operator-role-codes.js";
import { enforceOperatorMfa, MFA_REQUIRED } from "../../../../../../src/server/auth/require-mfa.js";
import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { logger } from "../../../../../../src/server/logger.js";
import { withSentryOpsScope } from "../../../../../../src/server/observability/ops-scope.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      logger.warn("ops.admin.api_key.revoke.mfa_denied", {
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

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const apiKeyId = typeof body["apiKeyId"] === "string" ? body["apiKeyId"].trim() : "";
  if (!UUID_REGEX.test(apiKeyId)) {
    return jsonError(400, "INVALID_API_KEY_ID", "apiKeyId must be a UUID.");
  }
  const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
  if (reason.length === 0) {
    return jsonError(400, "REASON_REQUIRED", "reason is required.");
  }

  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  return await withSentryOpsScope(
    {
      operatorUserId: session.operator.userId,
      organizationId: session.tenancy.organizationId,
      operatorDisplayName: session.operator.displayName,
      commandName: RevokeApiKey.name,
      route: "route:revoke-api-key",
    },
    async () => {
      try {
        const output = await withTenancyContext(tenancy, () =>
          executeCommand(
            RevokeApiKey,
            { apiKeyId, reason },
            // Minute-bucket free: revocation of one key is naturally
            // idempotent per (key, reason); a replay returns the
            // original output, a second distinct revoke fails typed.
            { idempotencyKey: `route:revoke-api-key:${apiKeyId}` }
          )
        );
        logger.info("ops.admin.api_key.revoke.applied", {
          operatorUserId: session.operator.userId,
          apiKeyId: output.apiKeyId,
          tokenPrefix: output.tokenPrefix,
        });
        return NextResponse.json({ data: output });
      } catch (cause) {
        const code = cause instanceof errors.PharmaxError ? cause.code : "OPS_DISPATCH_FAILED";
        const message =
          cause instanceof errors.PharmaxError ? cause.message : "Unable to revoke API key.";
        logger.error("ops.admin.api_key.revoke.failed", {
          operatorUserId: session.operator.userId,
          code,
          error: cause,
        });
        const status = code === "REVOKE_API_KEY_NOT_FOUND" ? 404 : 422;
        return jsonError(status, code, message);
      }
    }
  );
}
