// /ops/admin/api-keys — partner API-key administration (ADR-0032).
//
// The last operator-facing piece of the Phase 7 P0 milestone: mint
// and revoke the bearer keys partners use against `/api/v1/**`.
//
// The mint/revoke controls are fetch-based client components (see
// `api-key-admin.tsx`) because the mint response returns the raw
// token exactly once in JSON — the redirect+flash `ActionForm`
// pattern used elsewhere in the console cannot deliver it.
//
// Scope options are the permission codes the v1 surface actually
// checks — a curated subset, not the whole RBAC registry, so an
// operator is steered toward least privilege.
//
// PHI: none. Key labels, prefixes, permission codes, timestamps.

import { API_KEY_QUOTA_TIERS, API_KEY_QUOTA_TIER_NAMES } from "@pharmax/partner-api";
import { PERMISSIONS, PERMISSION_METADATA } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listApiKeys, type ApiKeyListRow } from "../../../../src/server/ops/list-api-keys.js";
import {
  MintApiKeyForm,
  RevokeApiKeyButton,
  type QuotaTierOption,
  type ScopeOption,
} from "../../../../src/components/ops/api-key-admin.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../src/components/ui/card.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";

// The scopes the v1 partner surface exercises today. Extend when a
// new `/api/v1` route checks a new permission code.
const PARTNER_SCOPE_CODES = [
  PERMISSIONS.ORDERS_READ,
  PERMISSIONS.ORDERS_CREATE,
  PERMISSIONS.WEBHOOKS_MANAGE,
] as const;

const SCOPE_OPTIONS: ReadonlyArray<ScopeOption> = PARTNER_SCOPE_CODES.map((code) => ({
  code,
  description: PERMISSION_METADATA[code].description,
}));

// Named quota tiers with their code-owned numbers rendered for the
// operator (the row stores only the tier NAME — see ADR-0032).
const QUOTA_TIER_OPTIONS: ReadonlyArray<QuotaTierOption> = API_KEY_QUOTA_TIER_NAMES.map((tier) => {
  const quota = API_KEY_QUOTA_TIERS[tier];
  return {
    tier,
    description: `${quota.burst.limit.toLocaleString("en-US")} req/min · ${quota.daily.limit.toLocaleString("en-US")} req/day`,
  };
});

function ts(d: Date | null): string {
  return d === null ? "—" : d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function KeyTable({ keys }: { readonly keys: ReadonlyArray<ApiKeyListRow> }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Key</TH>
          <TH>Scopes</TH>
          <TH>Tier</TH>
          <TH>Status</TH>
          <TH>Last used</TH>
          <TH>Created</TH>
          <TH className="sr-only">Actions</TH>
        </TR>
      </THead>
      <TBody>
        {keys.map((k) => (
          <TR key={k.apiKeyId}>
            <TD>
              <div className="space-y-0.5">
                <div className="text-sm font-medium text-fg">{k.name}</div>
                <code className="font-mono text-xs text-subtle">{k.tokenPrefix}…</code>
              </div>
            </TD>
            <TD>
              <div className="flex flex-wrap gap-1">
                {k.scopes.map((s) => (
                  <Badge key={s} tone="neutral">
                    {s}
                  </Badge>
                ))}
              </div>
            </TD>
            <TD>
              <Badge tone={k.quotaTier === "ELEVATED" ? "info" : "neutral"}>
                {k.quotaTier.toLowerCase()}
              </Badge>
            </TD>
            <TD>
              {k.status === "ACTIVE" ? (
                <Badge tone="success">active</Badge>
              ) : (
                <div className="space-y-0.5">
                  <Badge tone="danger">revoked</Badge>
                  <div className="text-2xs text-subtle">
                    {ts(k.revokedAt)}
                    {k.revokedReason !== null ? ` — ${k.revokedReason}` : ""}
                  </div>
                </div>
              )}
            </TD>
            <TD>
              <span className="text-xs text-muted">{ts(k.lastUsedAt)}</span>
            </TD>
            <TD>
              <div className="space-y-0.5">
                <span className="text-xs text-muted">{ts(k.createdAt)}</span>
                <div className="text-2xs text-subtle">by {k.createdByDisplayName}</div>
              </div>
            </TD>
            <TD className="text-right">
              {k.status === "ACTIVE" ? (
                <RevokeApiKeyButton
                  apiKeyId={k.apiKeyId}
                  name={k.name}
                  tokenPrefix={k.tokenPrefix}
                />
              ) : null}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export default async function ApiKeysAdminPage() {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.API_KEYS_MANAGE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="API keys" />
        <PermissionDenied grant="api.keys.manage" />
      </div>
    );
  }

  const keys = await listApiKeys({ organizationId: session.tenancy.organizationId });
  const active = keys.filter((k) => k.status === "ACTIVE");
  const revoked = keys.filter((k) => k.status !== "ACTIVE");

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="API keys"
        description="Bearer keys partners use against the public v1 API. Tokens are shown once at mint time and stored only as hashes; a key's authority is bounded by its scopes."
      />

      <Section title="Mint key">
        <Card>
          <CardContent>
            <MintApiKeyForm scopeOptions={SCOPE_OPTIONS} quotaTierOptions={QUOTA_TIER_OPTIONS} />
          </CardContent>
        </Card>
      </Section>

      <Section title="Active keys" count={active.length}>
        {active.length === 0 ? (
          <EmptyState
            icon="key"
            title="No active keys"
            description="Mint one above to give a partner access to the v1 API."
          />
        ) : (
          <KeyTable keys={active} />
        )}
      </Section>

      {revoked.length > 0 ? (
        <Section title="Revoked keys" count={revoked.length}>
          <KeyTable keys={revoked} />
        </Section>
      ) : null}
    </div>
  );
}
