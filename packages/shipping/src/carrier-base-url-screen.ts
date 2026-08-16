// Retro-screening for STORED carrier credentials.
//
// `RegisterCarrierCredential` screens `baseUrl` through
// `net.classifyOutboundUrl` before it writes anything, so no NEW row
// can carry a non-public destination. But that guard shipped after
// the column did, and a write-time check does not clean a table it
// was added to. Rows created BEFORE it are still stored and still
// dialled: `resolveShippingAdapter` reads `baseUrl` back verbatim,
// and the FedEx/UPS tracking pollers rebuild a client every tick —
// so one bad row re-sends the decrypted credential on a loop, with
// nobody watching.
//
// This module is the pure verdict layer used to find those rows. It
// holds no Prisma, no IO, and no policy of its own: it re-derives the
// SAME verdict the write path derives, from the same shared guard, so
// the audit and the command cannot drift apart. The operator tool
// that scans the table is `scripts/security/audit-carrier-base-urls.ts`.
//
// Why there is no `baseUrlScreenedAt` column
//
// The verdict is a pure function of the stored `baseUrl` and the
// current policy, so caching it buys nothing and can lie: a row
// stamped "clean" today is not clean under a future per-vendor
// hostname allowlist, and nothing would re-stamp it. Re-deriving on
// every run is always current. The only thing a column would add is
// "an operator has acknowledged this row", and that belongs in the
// ticket tracking the remediation, not in the schema.
//
// PHI: none. A carrier credential is a high-impact secret but is not
// PHI, and nothing here reads the encrypted columns at all. A finding
// carries ids, the provider, the row status, and a REDACTED
// destination — scheme and host only, via `net.redactUrlForReport`.
// Findings are built to be safe to paste into a ticket.

import { CarrierCredentialStatus, type ShippingProvider } from "@pharmax/database";
import { net } from "@pharmax/platform-core";

/**
 * The non-secret projection of a `carrier_credential` row that
 * screening needs. Deliberately excludes `apiKeyEnc` and
 * `webhookSecretEnc` so a caller cannot hand key material to a
 * reporting path even by accident.
 */
export interface StoredCarrierCredentialRow {
  readonly id: string;
  readonly organizationId: string;
  readonly provider: ShippingProvider;
  readonly status: CarrierCredentialStatus;
  readonly baseUrl: string | null;
  readonly createdAt: Date;
}

export interface CarrierBaseUrlFinding {
  readonly credentialId: string;
  readonly organizationId: string;
  readonly provider: ShippingProvider;
  readonly status: CarrierCredentialStatus;
  /**
   * Whether the read path will hand this row to a carrier client as
   * things stand. `resolveShippingAdapter` only ever selects the
   * ACTIVE row, so this is the triage axis that matters: an ACTIVE
   * finding is leaking the credential on every poller tick right
   * now, while a DISABLED finding is a historical artifact whose
   * credential has already been exposed but is no longer being
   * re-sent.
   */
  readonly dialledToday: boolean;
  readonly reason: net.OutboundUrlRejection;
  /** Guard-supplied cause. Names the address class, never the URL. */
  readonly detail: string;
  /** Scheme + host only. Never userinfo, path, query, or fragment. */
  readonly redactedBaseUrl: string;
  readonly createdAt: string;
}

/**
 * Screen one stored row. Returns `null` when the row is fine —
 * either it has no `baseUrl` override at all (the client falls back
 * to the carrier's own default host, which is always legitimate) or
 * the stored value passes the same guard the write path applies.
 */
export function screenStoredCarrierBaseUrl(
  row: StoredCarrierCredentialRow
): CarrierBaseUrlFinding | null {
  if (row.baseUrl === null) {
    return null;
  }
  const verdict = net.classifyOutboundUrl(row.baseUrl);
  if (verdict.ok) {
    return null;
  }
  return Object.freeze({
    credentialId: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    status: row.status,
    dialledToday: row.status === CarrierCredentialStatus.ACTIVE,
    reason: verdict.reason,
    detail: verdict.detail,
    redactedBaseUrl: net.redactUrlForReport(row.baseUrl),
    createdAt: row.createdAt.toISOString(),
  });
}

export interface CarrierBaseUrlFindingSummary {
  readonly total: number;
  /** Findings on the ACTIVE row — i.e. leaking on every tick. */
  readonly dialledToday: number;
  readonly organizationsAffected: number;
  readonly byReason: Readonly<Partial<Record<net.OutboundUrlRejection, number>>>;
}

/** Roll findings up for the report header. Pure; no IO. */
export function summarizeCarrierBaseUrlFindings(
  findings: ReadonlyArray<CarrierBaseUrlFinding>
): CarrierBaseUrlFindingSummary {
  const byReason: Partial<Record<net.OutboundUrlRejection, number>> = {};
  const organizations = new Set<string>();
  let dialledToday = 0;

  for (const finding of findings) {
    byReason[finding.reason] = (byReason[finding.reason] ?? 0) + 1;
    organizations.add(finding.organizationId);
    if (finding.dialledToday) {
      dialledToday += 1;
    }
  }

  return Object.freeze({
    total: findings.length,
    dialledToday,
    organizationsAffected: organizations.size,
    byReason: Object.freeze(byReason),
  });
}
