// /ops/admin/webhooks — outbound webhook administration (ADR-0032
// developer portal).
//
// Two surfaces:
//   - Subscriptions: every partner endpoint in the org with its
//     event-type filter and per-status delivery counts. Operators
//     can DISABLE a subscription (kill switch for a compromised or
//     offboarded receiver); creation and secret rotation stay on
//     the partner-facing v1 API where the one-time secret handoff
//     belongs.
//   - Delivery ledger: the newest deliveries with attempt counts,
//     response codes, and backoff timing — the "is my partner
//     receiving events" health view, doubling as the dead-letter
//     queue (DEAD rows stay visible).
//
// PHI: none. Endpoint URLs, registry event names (phi-safe by
// construction), statuses, timestamps. The signing secret is never
// loaded by this page's readers.

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  listRecentWebhookDeliveries,
  listWebhookSubscriptions,
  type WebhookDeliveryListRow,
  type WebhookSubscriptionListRow,
} from "../../../../src/server/ops/list-webhook-subscriptions.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Input } from "../../../../src/components/ui/field.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { ActionForm, SubmitButton } from "../../../../src/components/ops/action-form.js";

function ts(d: Date | null): string {
  return d === null ? "—" : d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function DeliveryStatusBadge({ status }: { readonly status: WebhookDeliveryListRow["status"] }) {
  switch (status) {
    case "SENT":
      return <Badge tone="success">sent</Badge>;
    case "PENDING":
      return <Badge tone="info">pending</Badge>;
    case "FAILED":
      return <Badge tone="warning">failed</Badge>;
    case "DEAD":
      return <Badge tone="danger">dead</Badge>;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function SubscriptionTable({
  subscriptions,
}: {
  readonly subscriptions: ReadonlyArray<WebhookSubscriptionListRow>;
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Endpoint</TH>
          <TH>Events</TH>
          <TH>Deliveries</TH>
          <TH>Status</TH>
          <TH>Created</TH>
          <TH className="sr-only">Actions</TH>
        </TR>
      </THead>
      <TBody>
        {subscriptions.map((s) => (
          <TR key={s.subscriptionId}>
            <TD>
              <div className="space-y-0.5">
                <code className="font-mono text-xs text-fg">{s.url}</code>
                {s.description !== null ? (
                  <div className="text-xs text-subtle">{s.description}</div>
                ) : null}
              </div>
            </TD>
            <TD>
              <div className="flex max-w-xs flex-wrap gap-1">
                {s.eventTypes.map((e) => (
                  <Badge key={e} tone="neutral">
                    {e}
                  </Badge>
                ))}
              </div>
            </TD>
            <TD>
              <div className="space-y-0.5 text-xs tabular-nums text-muted">
                <div>
                  {s.deliveryCounts.SENT} sent · {s.deliveryCounts.PENDING} pending
                </div>
                <div>
                  {s.deliveryCounts.FAILED} failed · {s.deliveryCounts.DEAD} dead
                </div>
              </div>
            </TD>
            <TD>
              {s.status === "ACTIVE" ? (
                <Badge tone="success">active</Badge>
              ) : (
                <div className="space-y-0.5">
                  <Badge tone="danger">disabled</Badge>
                  <div className="text-2xs text-subtle">{ts(s.disabledAt)}</div>
                </div>
              )}
            </TD>
            <TD>
              <div className="space-y-0.5">
                <span className="text-xs text-muted">{ts(s.createdAt)}</span>
                <div className="text-2xs text-subtle">by {s.createdByDisplayName}</div>
              </div>
            </TD>
            <TD className="text-right">
              {s.status === "ACTIVE" ? (
                <ActionForm
                  action="/api/ops/admin/webhooks/revoke"
                  confirm={`Disable webhook deliveries to ${s.url}? In-flight deliveries will be dead-lettered. This cannot be undone — the partner must create a new subscription.`}
                  className="flex items-center justify-end gap-2"
                >
                  <input type="hidden" name="subscriptionId" value={s.subscriptionId} />
                  <Input
                    type="text"
                    name="reason"
                    required
                    maxLength={500}
                    placeholder="Reason"
                    className="w-36"
                  />
                  <SubmitButton variant="danger" size="sm">
                    Disable
                  </SubmitButton>
                </ActionForm>
              ) : null}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function DeliveryTable({
  deliveries,
}: {
  readonly deliveries: ReadonlyArray<WebhookDeliveryListRow>;
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Event</TH>
          <TH>Endpoint</TH>
          <TH>Status</TH>
          <TH className="text-right">Attempts</TH>
          <TH className="text-right">HTTP</TH>
          <TH>Created</TH>
          <TH>Delivered / next try</TH>
        </TR>
      </THead>
      <TBody>
        {deliveries.map((d) => (
          <TR key={d.deliveryId}>
            <TD>
              <code className="font-mono text-xs text-fg">{d.eventType}</code>
            </TD>
            <TD>
              <code className="font-mono text-xs text-subtle">{d.subscriptionUrl}</code>
            </TD>
            <TD>
              <div className="space-y-0.5">
                <DeliveryStatusBadge status={d.status} />
                {d.lastError !== null ? (
                  <div className="max-w-xs truncate text-2xs text-subtle" title={d.lastError}>
                    {d.lastError}
                  </div>
                ) : null}
              </div>
            </TD>
            <TD className="text-right tabular-nums">{d.attempts}</TD>
            <TD className="text-right tabular-nums">{d.responseStatus ?? "—"}</TD>
            <TD>
              <span className="text-xs text-muted">{ts(d.createdAt)}</span>
            </TD>
            <TD>
              <span className="text-xs text-muted">
                {d.deliveredAt !== null ? ts(d.deliveredAt) : ts(d.nextAttemptAt)}
              </span>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export default async function WebhooksAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.WEBHOOKS_MANAGE)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Webhooks" />
        <PermissionDenied grant="webhooks.manage" />
      </div>
    );
  }

  const organizationId = session.tenancy.organizationId;
  const [subscriptions, deliveries] = await Promise.all([
    listWebhookSubscriptions({ organizationId }),
    listRecentWebhookDeliveries({ organizationId, limit: 50 }),
  ]);
  const flash = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="Webhooks"
        description="Outbound event deliveries to partner endpoints. Partners create subscriptions and rotate signing secrets through the v1 API with their own keys; this console is the org-side health view and kill switch."
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="That action didn't go through">
          {flashError}
        </Banner>
      ) : null}

      <Section title="Subscriptions" count={subscriptions.length}>
        {subscriptions.length === 0 ? (
          <EmptyState
            icon="externalLink"
            title="No webhook subscriptions"
            description="Partners create subscriptions via POST /api/v1/webhook-subscriptions using an API key with the webhooks.manage scope."
          />
        ) : (
          <SubscriptionTable subscriptions={subscriptions} />
        )}
      </Section>

      <Section title="Recent deliveries" count={deliveries.length}>
        {deliveries.length === 0 ? (
          <EmptyState
            icon="history"
            title="No deliveries yet"
            description="Deliveries appear here as soon as a subscribed event fires."
          />
        ) : (
          <DeliveryTable deliveries={deliveries} />
        )}
      </Section>
    </div>
  );
}
