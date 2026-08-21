// /ops/admin/providers — prescriber directory.
//
// Read-only roster of prescribing providers. NPI / name / credential /
// practice contact are public registry data (HIPAA Safe Harbor) — not
// PHI. Register / update / deactivate flows go through the provider
// commands, not this page.
//
// Permission gate: `providers.read`.

import Link from "next/link";

import { ProviderStatus } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  listProviders,
  type ProviderDeaSummary,
} from "../../../../src/server/ops/list-providers.js";
import { PageHeader, Section, FilterTabs } from "../../../../src/components/ui/page.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { inputClass } from "../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";

function pluck(
  params: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const v = params[key];
  if (typeof v !== "string" || v.trim().length === 0) return undefined;
  return v.trim();
}

function parseStatus(value: string | undefined): ProviderStatus | undefined {
  return value !== undefined && (Object.values(ProviderStatus) as string[]).includes(value)
    ? (value as ProviderStatus)
    : undefined;
}

/**
 * The roster answers "may this prescriber write controlled
 * substances", not "what is their DEA number". The number is a
 * prescription-fraud vector — the write commands redact it from
 * `command_log` for exactly that reason — and a roster view has no use
 * for it. It lives on the credential surface behind its own grant.
 */
function deaCell(dea: ProviderDeaSummary) {
  if (dea.total === 0) {
    return <span className="text-subtle">No DEA on file</span>;
  }
  if (dea.hasLapsed) {
    return <Badge tone="danger">Lapsed or revoked</Badge>;
  }
  if (dea.soonestExpiresAt === null) {
    // Registered, but nobody recorded when it expires. Not a refusal —
    // the gate lets it through — but it is the gap worth closing.
    return <Badge tone="warning">No expiry recorded</Badge>;
  }
  return (
    <span className="flex items-center gap-2">
      <Badge tone="success">Authorized</Badge>
      <span className="text-xs text-muted">
        to {dea.soonestExpiresAt.toLocaleDateString("en-US")}
      </span>
    </span>
  );
}

function pageHref(input: {
  readonly status?: ProviderStatus | undefined;
  readonly q?: string | undefined;
  readonly cursor?: string | undefined;
}): string {
  const search = new URLSearchParams();
  if (input.status !== undefined) search.set("status", input.status);
  if (input.q !== undefined) search.set("q", input.q);
  if (input.cursor !== undefined) search.set("cursor", input.cursor);
  const qs = search.toString();
  return qs.length === 0 ? "/ops/admin/providers" : `/ops/admin/providers?${qs}`;
}

export default async function ProviderAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.PROVIDERS_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Providers" />
        <PermissionDenied grant="providers.read" />
      </div>
    );
  }

  const status = parseStatus(pluck(params, "status"));
  const q = pluck(params, "q");
  const cursor = pluck(params, "cursor");
  const result = await listProviders({
    organizationId: session.tenancy.organizationId,
    ...(status !== undefined ? { status } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Directory"
        title="Providers"
        description="Prescribing providers this organization fills for. NPI and practice contact are public registry data — not PHI. The NPI sync worker keeps rows reconciled against CMS NPPES."
        actions={
          hasOperatorPermission(permissions, PERMISSIONS.PROVIDERS_CREATE) ? (
            <Link
              href="/ops/admin/providers/new"
              className="inline-flex items-center gap-1.5 text-sm text-brand transition-colors hover:text-fg"
            >
              <Icon name="plus" size={15} />
              Register a prescriber
            </Link>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <FilterTabs
          items={[
            { href: pageHref({ q }), label: "All", active: status === undefined },
            ...Object.values(ProviderStatus).map((s) => ({
              href: pageHref({ status: s, q }),
              label: s,
              active: status === s,
            })),
          ]}
        />
        <form method="GET" className="flex flex-wrap items-center gap-2">
          {status !== undefined ? <input type="hidden" name="status" value={status} /> : null}
          <input
            type="text"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Last name or NPI prefix"
            autoComplete="off"
            className={inputClass("max-w-xs")}
          />
          <button type="submit" className={buttonClass({ variant: "secondary" })}>
            <Icon name="search" size={16} />
            Search
          </button>
        </form>
      </div>

      <Section title="Roster" count={result.rows.length}>
        {result.rows.length === 0 ? (
          <EmptyState
            icon="providers"
            title="No providers match"
            description="Check the name or NPI spelling, or review the onboarding queue — applicants aren't listed here until they're approved."
            action={{ label: "Review provider onboarding", href: "/ops/admin/provider-onboarding" }}
          />
        ) : (
          <Table>
            <THead>
              <TH>Provider</TH>
              <TH>NPI</TH>
              <TH>Controlled substances</TH>
              <TH>Location</TH>
              <TH>Phone</TH>
              <TH>Status</TH>
            </THead>
            <TBody>
              {result.rows.map((row) => (
                <TR key={row.providerId}>
                  <TD className="font-medium">
                    <Link
                      href={`/ops/admin/providers/${row.providerId}`}
                      className="transition-colors hover:text-brand"
                    >
                      {row.lastName}, {row.firstName}
                      {row.credential !== null ? (
                        <span className="text-muted"> · {row.credential}</span>
                      ) : null}
                    </Link>
                  </TD>
                  <TD className="font-mono text-xs">{row.npi}</TD>
                  <TD>{deaCell(row.dea)}</TD>
                  <TD>
                    {row.city !== null || row.state !== null
                      ? [row.city, row.state].filter((s) => s !== null).join(", ")
                      : "—"}
                  </TD>
                  <TD className="font-mono text-xs">{row.phone ?? "—"}</TD>
                  <TD>
                    <Badge tone={row.status === "ACTIVE" ? "success" : "neutral"}>
                      {row.status}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      {result.nextCursor !== null ? (
        <div>
          <Link
            href={pageHref({ status, q, cursor: result.nextCursor })}
            className={buttonClass({ variant: "secondary" })}
          >
            Next page
            <Icon name="arrowRight" size={16} />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
