// GET /api/portal/v1/onboarding/applications/:id — public
// application-status lookup (ADR-0033, slice 2).
//
// The application id (a v4 UUID returned only in the submit
// response) is the capability: unguessable, and what it unlocks is a
// deliberately tiny projection — status + timestamps, never the
// identity-claim fields. Per-IP rate limited like the submit
// endpoint; unknown and malformed ids return the same 404.

import { createRateLimiterFromEnv } from "@pharmax/composition";
import { NextResponse } from "next/server";
import { z } from "zod";

import { partnerJsonError } from "@/server/partner/resolve-partner-context";
import { getPortalApplicationStatus } from "@/server/portal/application-status";
import { env } from "@/server/env";
import { resolveClientIp } from "@/server/http/client-ip";
import { logger } from "@/server/logger";

const rateLimiterHandle = createRateLimiterFromEnv({
  redisUrl: env.REDIS_URL,
  logger: logger.child({ component: "portal-onboarding-status-rate-limit" }),
});

const PER_IP_RULE = { limit: 30, windowMs: 60_000 };

const idSchema = z.uuid();

export async function GET(
  request: Request,
  context: { params: Promise<{ applicationId: string }> }
): Promise<Response> {
  const ip = resolveClientIp(request) ?? "unknown";
  const hit = await rateLimiterHandle.rateLimiter.hit(
    `portal-onboarding-status:ip:${ip}`,
    PER_IP_RULE
  );
  if (!hit.allowed) {
    return partnerJsonError({
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many status requests. Retry later.",
      headers: { "retry-after": String(Math.ceil(hit.retryAfterMs / 1000)) },
    });
  }

  const { applicationId } = await context.params;
  const parsedId = idSchema.safeParse(applicationId);
  const status = parsedId.success === true ? await getPortalApplicationStatus(parsedId.data) : null;
  if (status === null) {
    return partnerJsonError({
      status: 404,
      code: "APPLICATION_NOT_FOUND",
      message: "No application found for this id.",
    });
  }

  return NextResponse.json({
    data: {
      applicationId: status.applicationId,
      status: status.status,
      submittedAt: status.submittedAt.toISOString(),
      decidedAt: status.decidedAt === null ? null : status.decidedAt.toISOString(),
    },
  });
}
