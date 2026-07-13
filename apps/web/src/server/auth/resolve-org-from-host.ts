// Resolve the sign-in organization from the request host subdomain.
//
// ADR-0030 chose per-org subdomains (e.g. `acme.pharmax.app`) as the
// sign-in org selector: the login form is just email+password, and the
// subdomain names the tenant. Operator email is unique only per org
// (`@@unique([organizationId, email])`), so the org must be known
// before authenticating.
//
// The subdomain maps to `organization.slug`. The lookup runs in a
// system-context frame (pre-tenant: we don't know the org yet) and only
// resolves ACTIVE orgs.

import "server-only";

import { OrganizationStatus, prisma, type PrismaClient } from "@pharmax/database";
import {
  applySystemSessionGuc,
  withSystemContext,
  type SessionGucExecutor,
} from "@pharmax/tenancy";

const REASON = "auth:resolve-org-from-host";

// Subdomains that are never a tenant slug.
const RESERVED_SUBDOMAINS = new Set(["www", "app", "api", "admin", "staging", "auth"]);

/** Extract a tenant subdomain from a Host header, or null. */
export function extractSubdomain(host: string | null | undefined): string | null {
  if (typeof host !== "string" || host.length === 0) return null;
  const hostname = (host.split(":")[0] ?? "").toLowerCase();
  if (hostname.length === 0) return null;

  const parts = hostname.split(".");
  // localhost dev: `acme.localhost`
  const isLocalhostWithSub = hostname.endsWith("localhost") && parts.length >= 2;
  const hasSubdomain = parts.length >= 3 || isLocalhostWithSub;
  if (!hasSubdomain) return null;

  const sub = parts[0] ?? "";
  if (sub.length === 0 || RESERVED_SUBDOMAINS.has(sub)) return null;
  return sub;
}

/** Resolve an ACTIVE organization id from its slug, or null. */
export async function resolveOrganizationIdFromSlug(
  slug: string,
  client: Pick<PrismaClient, "$transaction"> = prisma
): Promise<string | null> {
  return withSystemContext(REASON, () =>
    client.$transaction(async (tx) => {
      await applySystemSessionGuc(tx as unknown as SessionGucExecutor, REASON);
      const org = await tx.organization.findUnique({
        where: { slug },
        select: { id: true, status: true },
      });
      if (org === null || org.status !== OrganizationStatus.ACTIVE) return null;
      return org.id;
    })
  );
}

/** Convenience: subdomain → org id from a Host header value. */
export async function resolveOrganizationIdFromHost(
  host: string | null | undefined
): Promise<string | null> {
  const sub = extractSubdomain(host);
  if (sub === null) return null;
  return resolveOrganizationIdFromSlug(sub);
}
