// PATCH /api/portal/v1/profile — prescriber self-service profile
// update (ADR-0033, slice 3), routed through the SAME `UpdateProvider`
// command operators use — no parallel mutation path, full
// command_log/audit_log/order_event-free provider.updated.v1 chain.
//
// Access rule: the portal session IS the authorization — the target
// provider is ALWAYS the session's own providerId (never from the
// request body), so a prescriber can only ever edit their own row.
//
// Field policy: CONTACT FIELDS ONLY (phone, email, address). Identity
// (name), credential, DEA, and NPI are deliberately NOT editable from
// the portal — those changes carry compliance weight and go through
// pharmacy staff. The Zod schema here is `.strict()`, so submitting
// any other field is a 400 before the command ever runs.
//
// Actor: the org's ProviderPortalService machine user (dedicated
// role, `providers.update` only — separate from the npi-sync
// identity so audit provenance stays truthful). The command's own
// RBAC + tenancy gates then apply as usual. The command_log's
// idempotency key carries the portal account id for attribution.

import { executeCommandDetailed } from "@pharmax/command-bus";
import { createRateLimiterFromEnv } from "@pharmax/composition";
import { prisma } from "@pharmax/database";
import { errors, ids } from "@pharmax/platform-core";
import { resolvePortalSession, UpdateProvider } from "@pharmax/providers";
import { buildTenancyContext, withSystemContext, withTenancyContext } from "@pharmax/tenancy";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  partnerJsonError,
  requireIdempotencyKeyHeader,
} from "../../../../../src/server/partner/resolve-partner-context.js";
import { env } from "../../../../../src/server/env.js";
import { logger } from "../../../../../src/server/logger.js";
import { readPortalSessionTokenFromRequest } from "../../../../../src/server/portal/session-cookie.js";

const rateLimiterHandle = createRateLimiterFromEnv({
  redisUrl: env.REDIS_URL,
  logger: logger.child({ component: "portal-profile-rate-limit" }),
});

const PER_ACCOUNT_RULE = { limit: 10, windowMs: 60_000 };

const PORTAL_ACTOR_EMAIL_LOCAL_PART = "provider-portal";

// Contact fields only — tri-state like UpdateProvider itself
// (absent = leave alone, null = clear, string = set). `.strict()`
// rejects identity/credential/DEA/NPI edits at the boundary.
const bodySchema = z
  .object({
    phone: z.string().min(7).max(40).nullable().optional(),
    email: z.email().max(320).nullable().optional(),
    addressLine1: z.string().min(1).max(200).nullable().optional(),
    addressLine2: z.string().min(1).max(200).nullable().optional(),
    city: z.string().min(1).max(100).nullable().optional(),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/, "expected 2-letter state code")
      .nullable()
      .optional(),
    postalCode: z
      .string()
      .regex(/^\d{5}(-\d{4})?$/, "expected ZIP or ZIP+4")
      .nullable()
      .optional(),
  })
  .strict();

export async function PATCH(request: NextRequest): Promise<Response> {
  const rawToken = readPortalSessionTokenFromRequest(request);
  if (rawToken === null) {
    return partnerJsonError({
      status: 401,
      code: "NOT_SIGNED_IN",
      message: "A portal session is required.",
    });
  }
  const resolution = await resolvePortalSession({ rawToken });
  if (!resolution.ok) {
    return partnerJsonError({
      status: 401,
      code: "NOT_SIGNED_IN",
      message: "A portal session is required.",
    });
  }
  const session = resolution.session;

  const idem = requireIdempotencyKeyHeader(request);
  if (!idem.ok) return idem.response;

  const hit = await rateLimiterHandle.rateLimiter.hit(
    `portal-profile:account:${session.portalAccountId}`,
    PER_ACCOUNT_RULE
  );
  if (!hit.allowed) {
    return partnerJsonError({
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many profile updates. Retry later.",
      headers: { "retry-after": String(Math.ceil(hit.retryAfterMs / 1000)) },
    });
  }

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
      code: "INVALID_PROFILE_UPDATE",
      message: "Profile update body is invalid (contact fields only).",
    });
  }

  // Machine-actor resolution (system context — the portal principal
  // has no tenant frame; mirrors the onboarding apply route).
  const actor = await withSystemContext("portal:profile:resolve-actor", async () => {
    const org = await prisma.organization.findUnique({
      where: { id: session.organizationId },
      select: { slug: true },
    });
    if (org === null) return null;
    return prisma.user.findFirst({
      where: {
        organizationId: session.organizationId,
        email: `${PORTAL_ACTOR_EMAIL_LOCAL_PART}@${org.slug}.test`,
        status: "ACTIVE",
      },
      select: { id: true },
    });
  });
  if (actor === null) {
    // Deployment error (service identity never provisioned), not a
    // caller error.
    logger.error("portal_profile.service_user_missing", {
      organizationId: session.organizationId,
    });
    return partnerJsonError({
      status: 503,
      code: "PROFILE_UPDATE_UNAVAILABLE",
      message: "Profile updates are temporarily unavailable. Retry later.",
    });
  }

  const tenancy = buildTenancyContext({
    organizationId: session.organizationId,
    actor: { userId: actor.id, correlationId: ids.generateUlid() },
  });

  try {
    const { output, replayed } = await withTenancyContext(tenancy, () =>
      executeCommandDetailed(
        UpdateProvider,
        {
          // The session's OWN provider row — never from the body.
          providerId: session.providerId,
          ...parsed.data,
        },
        {
          // The portal account id inside the key attributes the
          // change to the prescriber in the command_log even though
          // the RBAC actor is the machine identity.
          idempotencyKey: `portal-profile:${session.portalAccountId}:${idem.key}`,
        }
      )
    );
    return NextResponse.json(
      {
        data: output,
        ...(replayed ? { meta: { idempotentReplay: true } } : {}),
      },
      { status: 200 }
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
