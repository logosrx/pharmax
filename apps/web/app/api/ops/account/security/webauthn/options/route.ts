// POST /api/ops/account/security/webauthn/options — begin registering
// a security key / passkey for the signed-in operator (ADR-0036).
//
// Authenticated JSON route (session resolved in-handler; proxy.ts
// already requires the cookie for /api/ops/*). Self-service — no
// RBAC permission beyond a valid session; the command runs on the bus
// so command_log/audit_log/outbox are written by contract.
//
// Returns `{ challengeId, options }` for the browser's
// `navigator.credentials.create()`; the ceremony result is submitted
// to the sibling /verify route.

import "server-only";

import { EnrollWebAuthnCredential } from "@pharmax/auth";
import { executeCommand } from "@pharmax/command-bus";
import { errors, ids } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import { resolveOperatorTenancyContext } from "../../../../../../../src/server/auth/resolve-tenancy.js";
import { resolveWebAuthnRp } from "../../../../../../../src/server/auth/webauthn-rp.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const rp = resolveWebAuthnRp(request);
  if (rp === null) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId: session.tenancy.actor.userId, correlationId: ids.generateUlid() },
  });

  return await withTenancyContext(tenancy, async () => {
    try {
      const out = await executeCommand(
        EnrollWebAuthnCredential,
        { rpId: rp.rpId },
        // A fresh challenge per click is intended — no dedupe window.
        { idempotencyKey: `route:webauthn-enroll:${ids.generateUlid()}` }
      );
      return NextResponse.json({
        ok: true,
        challengeId: out.challengeId,
        options: out.optionsJSON,
      });
    } catch (cause) {
      if (errors.isPharmaxError(cause)) {
        return NextResponse.json(
          { error: cause.message, code: cause.code },
          { status: cause.httpStatus }
        );
      }
      throw cause;
    }
  });
}
