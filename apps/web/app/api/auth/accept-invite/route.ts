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

const bodySchema = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Client-most entry of the forwarded chain, matching the other
 * rate-limit call sites (`/api/portal/v1/auth/setup`).
 *
 * Trust caveat, recorded rather than papered over: a caller that sends
 * its own `x-forwarded-for` sits ahead of whatever the load balancer
 * appends, so this value is client-influenced and a determined attacker
 * can rotate it to buy fresh buckets. Fixing that means deciding how
 * many proxies are trusted and applies equally to sign-in — a
 * deployment-wide change, not one this route should make unilaterally.
 * The limit still holds against the ordinary flood and against a
 * misbehaving client.
 */
function clientIpOf(request: NextRequest): string | undefined {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : undefined;
}

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
      ipAddress: clientIpOf(request),
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
