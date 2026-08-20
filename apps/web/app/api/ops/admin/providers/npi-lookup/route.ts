// GET /api/ops/admin/providers/npi-lookup?npi=1234567893
//
// Validate an NPI against the CMS NPPES registry and return the
// registrant's name, credential and practice address so the register-a-
// prescriber form can fill itself in.
//
// A READ, NOT A COMMAND. Nothing is written, so this does not go
// through the command bus: there is no state change to log, no
// idempotency to key, and no audit row that would mean anything
// ("operator looked up a public identifier"). It is gated on
// `providers.create` because that is who has a use for it — the form
// this feeds.
//
// The NPPES client already existed for the provider-sync worker and the
// onboarding prover; this is a third caller of the same transport.
// Sharing it matters for one specific reason: the client serializes
// request START times through a process-wide gate at roughly 8 req/s
// against CMS's ~10/s ceiling, so an operator hammering this form
// cannot get the sync worker rate-limited.
//
// NPPES HAS NO DEA DATA. It is a separate federal registry and provider
// DEA status is never inferred from NPI status — see the note in
// `diff-engine.ts`. This returns identity and address only.
//
// PHI: none. NPPES is a public dataset.

import { CmsNppesClient } from "@pharmax/providers";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { NextResponse, type NextRequest } from "next/server";

import { hasOperatorPermission, loadOperatorPermissions } from "@/server/auth/operator-permissions";
import { resolveOperatorTenancyContext } from "@/server/auth/resolve-tenancy";
import { logger } from "@/server/logger";

/**
 * One client for the lifetime of the server process, so the rate gate
 * is shared across requests. A per-request client would give every
 * concurrent operator its own 8 req/s allowance and collectively
 * exceed what CMS permits.
 */
let client: CmsNppesClient | null = null;
function getClient(): CmsNppesClient {
  client ??= new CmsNppesClient({
    userAgent: `pharmax-web/0.1.0 (${process.env["NODE_ENV"] ?? "development"})`,
  });
  return client;
}

export async function GET(request: NextRequest): Promise<Response> {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.PROVIDERS_CREATE)) {
    return NextResponse.json({ error: "providers.create is required." }, { status: 403 });
  }

  const npi = request.nextUrl.searchParams.get("npi");
  if (npi === null || !/^\d{10}$/.test(npi)) {
    return NextResponse.json({ error: "An NPI is exactly 10 digits." }, { status: 400 });
  }

  try {
    const snapshot = await getClient().fetchByNpi(npi);
    if (snapshot === null) {
      // A 200 with zero results, not an error — CMS distinguishes
      // "no such NPI" from "the registry is unreachable", and so does
      // the operator's next action.
      return NextResponse.json({ found: false }, { status: 200 });
    }

    return NextResponse.json({
      found: true,
      npi: snapshot.npi,
      enumerationType: snapshot.enumerationType,
      /** "A" = active, "D" = deactivated. Surfaced, not enforced here. */
      status: snapshot.status,
      firstName: snapshot.firstName,
      lastName: snapshot.lastName,
      credential: snapshot.credential,
      practiceAddress: snapshot.practiceAddress,
    });
  } catch (cause) {
    // A registry outage must not read as "this NPI does not exist" —
    // that would send the operator to correct a number that is fine.
    const code = errors.isPharmaxError(cause) ? cause.code : "NPI_LOOKUP_FAILED";
    logger.warn("ops.provider.npi_lookup.failed", {
      event: "ops.provider.npi_lookup.failed",
      operatorUserId: session.tenancy.actor.userId,
      organizationId: session.tenancy.organizationId,
      npi,
      code,
    });
    return NextResponse.json(
      {
        error:
          "The NPI registry could not be reached. Enter the prescriber's details manually and retry the lookup later.",
        code,
      },
      { status: 502 }
    );
  }
}
