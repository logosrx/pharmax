// /ops/admin/buckets — operational queue bucket admin.
//
// Lists every bucket in the org, system and custom, in queue-rail
// order. System buckets are badged so it is obvious before clicking
// why their edit form is narrower. Gate: `org.manage_buckets`.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listBuckets } from "../../../../src/server/ops/list-buckets.js";
import { PageHeader } from "../../../../src/components/ui/page.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";

function kindTone(kind: string): Tone {
  switch (kind) {
    case "EMERGENCY":
      return "danger";
    case "WORKFLOW":
      return "success";
    case "HOLD":
      return "warning";
    default:
      return "neutral";
  }
}

function scopeLabel(row: {
  readonly siteName: string | null;
  readonly clinicName: string | null;
  readonly teamName: string | null;
}): string {
  const parts = [row.siteName, row.clinicName, row.teamName].filter(
    (p): p is string => p !== null && p.length > 0
  );
  return parts.length === 0 ? "Organization-wide" : parts.join(" / ");
}

export default async function BucketsAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly flash?: string; readonly error?: string }>;
}) {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.ORG_MANAGE_BUCKETS)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Buckets" />
        <PermissionDenied grant="org.manage_buckets" />
      </div>
    );
  }

  const rows = await listBuckets({ tenancy: result.tenancy });
  const { flash, error } = await searchParams;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="Buckets"
        description="Operational queues orders sit in. The seven system buckets are routed into automatically by the workflow engine; custom buckets are moved into by hand and are yours to shape."
        actions={
          <Link href="/ops/admin/buckets/new" className={buttonClass({ variant: "primary" })}>
            <Icon name="plus" size={16} />
            New bucket
          </Link>
        }
      />

      {typeof flash === "string" && flash.length > 0 ? (
        <Banner tone="success">{flash}</Banner>
      ) : null}
      {typeof error === "string" && error.length > 0 ? (
        <Banner tone="danger">{error}</Banner>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon="dashboard"
          title="No buckets yet"
          description="This organization has not been provisioned with the canonical workflow buckets. Order intake will fail until it is."
          action={{ label: "Create a custom bucket", href: "/ops/admin/buckets/new", icon: "plus" }}
          hint="Canonical workflow buckets are provisioned by ProvisionDefaultBuckets, not created by hand."
        />
      ) : (
        <Table>
          <THead>
            <TH>Code</TH>
            <TH>Name</TH>
            <TH>Kind</TH>
            <TH>Scope</TH>
            <TH align="right">Order</TH>
            <TH align="right">Orders</TH>
            <TH align="right" />
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD>
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{row.code}</code>
                  {row.isSystem ? (
                    <span className="ml-2">
                      <Badge tone="neutral">system</Badge>
                    </span>
                  ) : null}
                </TD>
                <TD>
                  <span className="font-medium text-fg">{row.name}</span>
                </TD>
                <TD>
                  <Badge tone={kindTone(row.kind)}>{row.kind}</Badge>
                </TD>
                <TD>
                  <span className="text-xs text-muted">{scopeLabel(row)}</span>
                </TD>
                <TD align="right">
                  <span className="font-mono text-xs text-muted">{row.sortOrder}</span>
                </TD>
                <TD align="right">{row.orderCount}</TD>
                <TD align="right">
                  <Link
                    href={`/ops/admin/buckets/${row.id}/edit`}
                    className={buttonClass({ variant: "secondary", size: "sm" })}
                  >
                    Edit
                  </Link>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
