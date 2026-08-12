// POST /api/ops/account/appearance — save the operator's own console
// theme (dark / light / system).
//
// Self-service: the SetThemePreference command always targets the
// session's own user row, so there is no RBAC or MFA floor here (same
// stance as the sibling /security/webauthn routes). On success the
// response also refreshes the `pharmax_theme` render-hint cookie so
// the next server-rendered page paints the saved theme immediately.

import "server-only";

import { SetThemePreference } from "@pharmax/auth";
import { executeCommand } from "@pharmax/command-bus";
import { errors, ids } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";
import { z } from "zod";

import { THEME_CHOICES, preferenceFromThemeChoice } from "@/lib/theme";
import { resolveOperatorTenancyContext } from "@/server/auth/resolve-tenancy";
import { setThemeCookie } from "@/server/theme-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  theme: z.enum(THEME_CHOICES),
});

export async function POST(request: Request): Promise<Response> {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.trim() === "") {
    return NextResponse.json(
      { error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key header required." } },
      { status: 400 }
    );
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const choice = parsed.data.theme;

  const userId = session.tenancy.actor.userId;
  const tenancy = buildTenancyContext({
    organizationId: session.tenancy.organizationId,
    actor: { userId, correlationId: ids.generateUlid() },
  });

  return await withTenancyContext(tenancy, async () => {
    try {
      const out = await executeCommand(
        SetThemePreference,
        { theme: preferenceFromThemeChoice(choice) },
        { idempotencyKey: `route:set-theme:${userId}:${idempotencyKey}` }
      );
      const response = NextResponse.json({ ok: true, theme: out.theme });
      setThemeCookie(response, choice);
      return response;
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
