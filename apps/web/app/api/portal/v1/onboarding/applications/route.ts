// POST /api/portal/v1/onboarding/applications — provider self-serve
// onboarding intake (ADR-0033, slice 1). The first portal API
// endpoint: versioned + contract-tested from day one.
//
// This route is UNAUTHENTICATED by necessity (the applicant has no
// credential yet), so it is deliberately narrow:
//
//   - Strict per-IP and per-(org, npi) rate limits (Redis-backed
//     when REDIS_URL is set).
//   - `Idempotency-Key` required, same contract as every public
//     write.
//   - The target org must have opted in
//     (`organization.providerOnboardingEnabled`); unknown slug and
//     disabled org return the SAME 404 — no enumeration surface.
//   - The command actor is the org's ProviderOnboardingService
//     machine user (least-privilege: `providers.onboarding.submit`
//     only). The applicant is never an actor — they have no
//     principal until slice 2's portal accounts.
//
// PHI: none. The claim is public professional identity (NPI +
// office contact). Logs carry org id + NPI only.

import { executeCommandDetailed } from "@pharmax/command-bus";
import { createRateLimiterFromEnv } from "@pharmax/composition";
import { prisma } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import { SubmitProviderOnboardingApplication } from "@pharmax/providers";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  partnerJsonError,
  requireIdempotencyKeyHeader,
} from "../../../../../../src/server/partner/resolve-partner-context.js";
import { env } from "../../../../../../src/server/env.js";
import { logger } from "../../../../../../src/server/logger.js";

const rateLimiterHandle = createRateLimiterFromEnv({
  redisUrl: env.REDIS_URL,
  logger: logger.child({ component: "portal-onboarding-rate-limit" }),
});

// Shape-only body gate: org routing + rate-limit keys need `npi`
// and `organizationSlug` before the command's own Zod runs. The
// command remains the authoritative validator for the claim fields.
const bodySchema = z
  .object({
    organizationSlug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    npi: z.string().regex(/^\d{10}$/),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    credential: z.string().min(1).max(40).optional(),
    email: z.email().max(320),
    phone: z.string().min(7).max(40).optional(),
  })
  .strict();

const PER_IP_RULE = { limit: 10, windowMs: 60_000 };
const PER_ORG_NPI_RULE = { limit: 3, windowMs: 60 * 60_000 };

const ONBOARDING_ACTOR_EMAIL_LOCAL_PART = "provider-onboarding";

function clientIpOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return "unknown";
}

export async function POST(request: Request): Promise<Response> {
  const idem = requireIdempotencyKeyHeader(request);
  if (!idem.ok) return idem.response;

  const raw = (await request.json().catch(() => null)) as unknown;
  if (raw === null) {
    return partnerJsonError({
      status: 400,
      code: "INVALID_JSON",
      message: "Request body must be valid JSON.",
    });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return partnerJsonError({
      status: 400,
      code: "INVALID_APPLICATION",
      message: "Application body is invalid.",
    });
  }
  const body = parsed.data;

  // Rate gates. Per-IP shapes drive-by abuse; per-(org, npi) caps
  // targeted hammering of one prescriber slot regardless of source
  // IPs. Both fail open on limiter errors (same posture as the
  // partner API).
  const ipHit = await rateLimiterHandle.rateLimiter.hit(
    `portal-onboarding:ip:${clientIpOf(request)}`,
    PER_IP_RULE
  );
  if (!ipHit.allowed) {
    return partnerJsonError({
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many onboarding requests. Retry later.",
      headers: { "retry-after": String(Math.ceil(ipHit.retryAfterMs / 1000)) },
    });
  }
  const npiHit = await rateLimiterHandle.rateLimiter.hit(
    `portal-onboarding:org-npi:${body.organizationSlug}:${body.npi}`,
    PER_ORG_NPI_RULE
  );
  if (!npiHit.allowed) {
    return partnerJsonError({
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many onboarding requests for this NPI. Retry later.",
      headers: { "retry-after": String(Math.ceil(npiHit.retryAfterMs / 1000)) },
    });
  }

  // Org + machine-actor resolution (system context — there is no
  // tenant frame to be in yet; mirrors the partner API's key
  // resolution step).
  const resolved = await withSystemContext("portal:onboarding:resolve-org", async () => {
    const org = await prisma.organization.findUnique({
      where: { slug: body.organizationSlug },
      select: { id: true, slug: true, status: true, providerOnboardingEnabled: true },
    });
    if (org === null || org.status !== "ACTIVE" || !org.providerOnboardingEnabled) {
      return null;
    }
    const actor = await prisma.user.findFirst({
      where: {
        organizationId: org.id,
        email: `${ONBOARDING_ACTOR_EMAIL_LOCAL_PART}@${org.slug}.test`,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    return { org, actor };
  });

  // Unknown slug, inactive org, and not-opted-in are all the SAME
  // 404 — the route never confirms an org exists.
  if (resolved === null) {
    return partnerJsonError({
      status: 404,
      code: "ONBOARDING_NOT_AVAILABLE",
      message: "Self-serve onboarding is not available for this organization.",
    });
  }
  if (resolved.actor === null) {
    // Org opted in but the service identity was never provisioned —
    // a deployment error, not a caller error.
    logger.error("portal_onboarding.service_user_missing", {
      organizationId: resolved.org.id,
    });
    return partnerJsonError({
      status: 503,
      code: "ONBOARDING_UNAVAILABLE",
      message: "Onboarding is temporarily unavailable. Retry later.",
    });
  }

  const tenancy = buildTenancyContext({
    organizationId: resolved.org.id,
    actor: { userId: resolved.actor.id, correlationId: ids.generateUlid() },
  });

  try {
    const { output, replayed } = await withTenancyContext(tenancy, () =>
      executeCommandDetailed(
        SubmitProviderOnboardingApplication,
        {
          npi: body.npi,
          firstName: body.firstName,
          lastName: body.lastName,
          ...(body.credential === undefined ? {} : { credential: body.credential }),
          email: body.email,
          ...(body.phone === undefined ? {} : { phone: body.phone }),
        },
        { idempotencyKey: `portal-onboarding:${resolved.org.id}:${idem.key}` }
      )
    );
    return NextResponse.json(
      {
        data: output,
        ...(replayed ? { meta: { idempotentReplay: true } } : {}),
      },
      { status: replayed ? 200 : 201 }
    );
  } catch (cause) {
    if (cause instanceof errors.PharmaxError) {
      return partnerJsonError({
        status: cause.httpStatus,
        code: cause.code,
        message: cause.message,
      });
    }
    throw cause;
  }
}
