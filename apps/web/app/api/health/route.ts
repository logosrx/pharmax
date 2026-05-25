// Liveness probe. Intentionally cheap: no DB ping, no Stripe call.
// A separate /api/readiness endpoint will be added later to gate
// load-balancer traffic on Postgres + Redis being reachable.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "pharmacy-os",
    timestamp: new Date().toISOString(),
  });
}
