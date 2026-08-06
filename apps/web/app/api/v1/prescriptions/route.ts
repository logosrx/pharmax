// /api/v1/prescriptions — partner transcription surface (ADR-0032,
// public v1).
//
//   POST — prescription intake. Scope: `prescriptions.create`.
//          Requires `Idempotency-Key`. Dispatches the same
//          `CreatePrescription` command the ops console uses, so every
//          safety property belongs to the command and not to this
//          route: the DEA schedule comes from the product catalog, the
//          refill cap is checked at issuance (21 CFR 1306.12(a) /
//          1306.22(a)), the prescriber must hold a DEA registration for
//          a controlled substance, and the Rx number comes from the
//          allocator.
//
// The parsed body is forwarded to the command UNCHANGED. Unlike
// /api/v1/orders there is no platform-owned field to force, so the
// command's strict input schema is the only shape gate — a misspelled
// or unknown field fails there rather than being silently dropped by a
// route-level projection.
//
// PHI: `sig`, both notes and the indication travel in this body. They
// are never logged, never echoed, and never placed in a URL here; the
// command encrypts them and redacts them from
// `command_log.requestPayload`. The response carries ids, the Rx
// number, the schedule and the expiry only.

import { executeCommandDetailed } from "@pharmax/command-bus";
import { CreatePrescription } from "@pharmax/orders";
import { PERMISSIONS } from "@pharmax/rbac";
import { withTenancyContext } from "@pharmax/tenancy";
import { NextResponse } from "next/server";

import {
  partnerCommandError,
  partnerJsonError,
  requireIdempotencyKeyHeader,
  requirePartnerScope,
  resolvePartnerContext,
} from "../../../../src/server/partner/resolve-partner-context.js";

export async function POST(request: Request): Promise<Response> {
  const resolved = await resolvePartnerContext(request);
  if (!resolved.ok) return resolved.response;
  const denied = requirePartnerScope(resolved.context, PERMISSIONS.PRESCRIPTIONS_CREATE);
  if (denied !== null) return denied;
  const idem = requireIdempotencyKeyHeader(request);
  if (!idem.ok) return idem.response;

  const body = (await request.json().catch(() => null)) as unknown;
  if (body === null) {
    return partnerJsonError({
      status: 400,
      code: "INVALID_JSON",
      message: "Request body must be valid JSON.",
    });
  }

  try {
    const { output, replayed } = await withTenancyContext(resolved.context.tenancy, () =>
      executeCommandDetailed(CreatePrescription, body, {
        idempotencyKey: `partner:${resolved.context.key.apiKeyId}:${idem.key}`,
      })
    );
    return NextResponse.json(
      {
        data: output,
        ...(replayed ? { meta: { idempotentReplay: true } } : {}),
      },
      { status: replayed ? 200 : 201 }
    );
  } catch (cause) {
    // Status comes from the error class, so `RX_NUMBER_COLLISION`
    // reaches the partner as the retryable 409 its own operator
    // wording promises, and `RX_NUMBER_ALLOCATION_FAILED` reaches
    // them (and our alerting) as the 500 it is.
    const mapped = partnerCommandError(cause);
    if (mapped !== null) return mapped;
    throw cause;
  }
}
