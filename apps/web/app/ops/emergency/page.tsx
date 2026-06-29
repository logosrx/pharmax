// /ops/emergency — escalated-order disposition.
//
// Lists orders currently in the EMERGENCY bucket. Each row carries a
// "Resolve" form that POSTs to /api/ops/orders/:id/resolve-escalation
// (dispatches `ResolveOrderEscalation` through the bus) to return the
// order to a workflow bucket or acknowledge ongoing triage.
//
// PHI: non-PHI structural columns only.

import { redirect } from "next/navigation";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { listEmergencyOrders } from "../../../src/server/ops/list-emergency-orders.js";
import { PageHeader } from "../../../src/components/ui/page.js";
import { EmptyState, PermissionDenied, Banner } from "../../../src/components/ui/feedback.js";
import { Badge } from "../../../src/components/ui/badge.js";
import { Field, Select, Input } from "../../../src/components/ui/field.js";
import { QueueRow } from "../../../src/components/ops/queue-row.js";
import { ActionForm, SubmitButton } from "../../../src/components/ops/action-form.js";

const DISPOSITION_OPTIONS = [
  { value: "RETURN_TO_SHIPPING", label: "Return to Shipping" },
  { value: "RETURN_TO_FILL", label: "Return to Fill" },
  { value: "KEEP_IN_EMERGENCY", label: "Keep in Emergency (audit only)" },
] as const;

function pick(p: Record<string, string | string[] | undefined>, k: string): string | null {
  const v = p[k];
  return typeof v === "string" ? v : null;
}

export default async function EmergencyQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) redirect("/sign-in");

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.SHIP_RESOLVE_ESCALATION)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Exceptions" title="Emergency queue" />
        <PermissionDenied grant="ship.resolve_escalation" />
      </div>
    );
  }

  const queue = await listEmergencyOrders({ organizationId: result.tenancy.organizationId });
  const resolved = pick(params, "resolved");
  const error = pick(params, "error");
  const now = Date.now();
  const nowDate = new Date(now);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Exceptions"
        title="Emergency queue"
        description="Orders escalated to the emergency bucket. Disposition each to return it to a workflow bucket or acknowledge ongoing triage."
      />

      {resolved !== null ? (
        <Banner tone="success">
          Resolved order <code>{resolved}</code>.
        </Banner>
      ) : null}
      {error !== null ? (
        <Banner tone="danger" title="That action didn't go through">
          {error}
        </Banner>
      ) : null}

      {!queue.bucketExists ? (
        <Banner tone="warning" title="EMERGENCY bucket not provisioned">
          Run <code>ProvisionDefaultBuckets</code> to create it for this organization.
        </Banner>
      ) : queue.rows.length === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing on fire"
          description="No orders are currently escalated. SLA breaches and shipping exceptions surface here."
        />
      ) : (
        <ul className="space-y-3">
          {queue.rows.map((row) => {
            const isSlaEscalation =
              row.latestShipmentEvent === null &&
              row.slaDeadlineAt !== null &&
              row.slaDeadlineAt.getTime() < now;
            return (
              <li key={row.orderId}>
                <QueueRow
                  orderId={row.orderId}
                  externalOrderNumber={row.externalOrderNumber}
                  priority={row.priority}
                  status={row.currentStatus}
                  slaDeadlineAt={row.slaDeadlineAt}
                  receivedAt={row.enteredEmergencyAt}
                  now={nowDate}
                  headerExtra={
                    isSlaEscalation ? (
                      <Badge tone="danger" icon="alert">
                        SLA breach
                      </Badge>
                    ) : undefined
                  }
                  note={
                    row.latestShipmentEvent !== null
                      ? `Latest shipment event: ${row.latestShipmentEvent.kind} (${row.latestShipmentEvent.carrierStatus})`
                      : undefined
                  }
                >
                  <ActionForm
                    action={`/api/ops/orders/${row.orderId}/resolve-escalation`}
                    className="flex w-full flex-wrap items-end gap-2"
                  >
                    <Field label="Disposition">
                      <Select name="disposition" defaultValue="RETURN_TO_SHIPPING">
                        {DISPOSITION_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Note" className="min-w-0 flex-1">
                      <Input
                        type="text"
                        name="reasonText"
                        placeholder="Optional operator note"
                        maxLength={2000}
                      />
                    </Field>
                    <SubmitButton variant="go" icon="check">
                      Resolve
                    </SubmitButton>
                  </ActionForm>
                </QueueRow>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
