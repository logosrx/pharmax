// POST /api/ops/account/security/webauthn/verify — finish registering
// a security key / passkey (ADR-0036).
//
// Verifies the authenticator's attestation against the single-use
// challenge minted by the sibling /options route, stores the
// credential, and — when this is the account's first authenticator —
// returns the freshly minted recovery codes (shown once, never
// logged).

import "server-only";

import { ConfirmWebAuthnCredential } from "@pharmax/auth";
import { executeCommand } from "@pharmax/command-bus";
import { errors, ids } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveOperatorTenancyContext } from "../../../../../../../src/server/auth/resolve-tenancy.js";
import { resolveWebAuthnRp } from "../../../../../../../src/server/auth/webauthn-rp.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  challengeId: z.string().uuid(),
  label: z.string().min(1).max(64),
  response: z.unknown(),
});

export async function POST(request: Request): Promise<Response> {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
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
        ConfirmWebAuthnCredential,
        {
          challengeId: parsed.data.challengeId,
          rpId: rp.rpId,
          origin: rp.origin,
          label: parsed.data.label,
          response: parsed.data.response,
        },
        // The single-use challenge is the natural idempotency anchor.
        { idempotencyKey: `route:webauthn-confirm:${parsed.data.challengeId}` }
      );
      return NextResponse.json({
        ok: true,
        credentialRowId: out.credentialRowId,
        recoveryCodes: out.recoveryCodes,
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
