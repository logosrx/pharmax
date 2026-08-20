// POST /api/auth/accept-invite — set the initial password + activate an
// invited operator (ADR-0030). Public route: the token IS the
// authorization. On success the operator signs in normally.
//
// Thin transport, as with /api/auth/sign-in: the burst limit lives in
// `acceptInvite` (see @pharmax/auth credential-setup-limit.ts) rather
// than here, so it protects the breach-corpus lookup wherever that
// orchestration is called from and shares one bucket with the reset
// path. This route's only job on that front is to hand the engine the
// client IP — without it every caller collapses into one `unknown`
// bucket and the limit stops isolating anybody.
//
// A rate-limited request comes back as the ordinary opaque
// RESET_TOKEN_INVALID, so the error branch below needs no special case
// and the response carries no tell about whether the token was real.

import { acceptInvite } from "@pharmax/auth";
import { errors } from "@pharmax/platform-core";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { resolveClientIp } from "@/server/http/client-ip";

const bodySchema = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: NextRequest): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    await acceptInvite({
      rawToken: parsed.data.token,
      newPassword: parsed.data.password,
      ipAddress: resolveClientIp(request),
    });
    return NextResponse.json({ ok: true });
  } catch (cause) {
    if (errors.isPharmaxError(cause)) {
      return NextResponse.json(
        { error: cause.message, code: cause.code },
        { status: cause.httpStatus }
      );
    }
    throw cause;
  }
}
