// Partner API-key projections — drive `/ops/admin/api-keys`.
//
// One reader: every partner key in the operator's org with its
// display prefix, scopes, lifecycle status, and minting operator.
// Keys per org are bounded (a handful of partner integrations), so
// this is a full list — no pagination.
//
// The token hash is deliberately NOT selected: this surface never
// needs it, and the raw token is unrecoverable by design (shown once
// at mint time by the create route).
//
// PHI: none. Key labels, permission codes, and operator identifiers.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import { readInOrgScope, type ApiKeyQuotaTier, type ApiKeyStatus } from "@pharmax/database";

export interface ApiKeyListRow {
  readonly apiKeyId: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scopes: ReadonlyArray<string>;
  readonly quotaTier: ApiKeyQuotaTier;
  readonly status: ApiKeyStatus;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly createdAt: Date;
  readonly createdByDisplayName: string;
}

export async function listApiKeys(input: {
  readonly organizationId: string;
}): Promise<ReadonlyArray<ApiKeyListRow>> {
  return readInOrgScope(input.organizationId, async (tx) => {
    const rows = await tx.apiKey.findMany({
      where: { organizationId: input.organizationId },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        scopes: true,
        quotaTier: true,
        status: true,
        lastUsedAt: true,
        revokedAt: true,
        revokedReason: true,
        createdAt: true,
        createdByUser: { select: { displayName: true } },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });

    return rows.map((r) =>
      Object.freeze({
        apiKeyId: r.id,
        name: r.name,
        tokenPrefix: r.tokenPrefix,
        scopes: [...r.scopes].sort(),
        quotaTier: r.quotaTier,
        status: r.status,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
        revokedReason: r.revokedReason,
        createdAt: r.createdAt,
        createdByDisplayName: r.createdByUser.displayName,
      })
    );
  });
}
