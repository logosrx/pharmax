// /ops/admin/notifications — notification delivery health.
//
// Lists the 100 most-recent notification_delivery rows (recipient,
// template, status, last event, failure reason). A "Problems only"
// filter narrows to BOUNCED / COMPLAINED / DELIVERY_DELAYED / FAILED.
//
// Permission gate: `notifications.read`.

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { listNotificationDeliveries } from "../../../../src/server/ops/list-notification-deliveries.js";
import { PageHeader, FilterTabs } from "../../../../src/components/ui/page.js";
import { Badge, type Tone } from "../../../../src/components/ui/badge.js";
import { EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";

function formatDate(d: Date | null): string {
  return d === null ? "—" : d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function statusTone(status: string): Tone {
  switch (status) {
    case "DELIVERED":
      return "success";
    case "SENT":
      return "info";
    case "QUEUED":
      return "neutral";
    case "DELIVERY_DELAYED":
      return "warning";
    default:
      return "danger";
  }
}

export default async function NotificationsHealthPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly problems?: string }>;
}) {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.NOTIFICATIONS_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Notification delivery" />
        <PermissionDenied grant="notifications.read" />
      </div>
    );
  }

  const { problems } = await searchParams;
  const problemsOnly = problems === "1";
  const rows = await listNotificationDeliveries({
    tenancy: result.tenancy,
    limit: 100,
    problemsOnly,
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="Notification delivery"
        description="Per-recipient delivery health for outbound notifications. Rows advance via the Resend webhook (DELIVERED / BOUNCED / COMPLAINED / DELAYED). A bouncing recipient on a schedule means a report isn't reaching someone."
        actions={
          <FilterTabs
            items={[
              { href: "/ops/admin/notifications", label: "All", active: !problemsOnly },
              {
                href: "/ops/admin/notifications?problems=1",
                label: "Problems only",
                active: problemsOnly,
              },
            ]}
          />
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon="notifications"
          title={problemsOnly ? "No problem deliveries" : "No notification deliveries yet"}
          description={
            problemsOnly
              ? "Every recent notification was accepted or delivered."
              : "Outbound notification attempts will appear here."
          }
        />
      ) : (
        <Table>
          <THead>
            <TH>Recipient</TH>
            <TH>Template</TH>
            <TH>Status</TH>
            <TH>Last event</TH>
            <TH align="right">Sent</TH>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD>
                  <span className="font-medium text-fg">{row.recipientAddress}</span>
                </TD>
                <TD>
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{row.template}</code>
                </TD>
                <TD>
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  {row.failureReason !== null ? (
                    <div className="mt-1 text-xs text-red-300">{row.failureReason}</div>
                  ) : null}
                </TD>
                <TD>
                  <div className="text-xs text-muted">{row.lastEventType ?? "—"}</div>
                  <div className="text-xs text-subtle">{formatDate(row.lastEventAt)}</div>
                </TD>
                <TD align="right">
                  <span className="text-xs text-muted">{formatDate(row.createdAt)}</span>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
