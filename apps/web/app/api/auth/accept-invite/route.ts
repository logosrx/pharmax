// POST /api/auth/accept-invite — set the initial password + activate an
// invited operator (ADR-0030). Public route: the token IS the
// authorization. On success the operator signs in normally.

import { acceptInvite } from "@pharmax/auth";
import { errors } from "@pharmax/platform-core";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

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
    await acceptInvite({ rawToken: parsed.data.token, newPassword: parsed.data.password });
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
