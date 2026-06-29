// /ops/fill — pharmacy tech FILL queue.
//
// Lists orders in the FILL bucket. Row variants:
//   - PV1_APPROVED_READY_FOR_FILL: anyone with `fill.start` can claim
//     (StartFill → FILL_IN_PROGRESS, stamps assignee).
//   - FILL_IN_PROGRESS: a workbench link to `/ops/fill/[id]` where the
//     assign-lot + print + scan + complete actions live. Only the
//     assignee can mutate (command-bus assignee guard).
//   - FINAL_VERIFICATION_REJECTED: a final-verification bounce-back —
//     reopen for fill rework.
//
// PHI: queue surface is non-PHI; the workbench is the action surface.

import Link from "next/link";

import { ReopenReason } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { listOrdersInBucketByCode } from "../../../src/server/ops/list-orders-in-bucket.js";
import { PageHeader } from "../../../src/components/ui/page.js";
import { EmptyState, PermissionDenied, Banner } from "../../../src/components/ui/feedback.js";
import { buttonClass } from "../../../src/components/ui/button.js";
import { Icon } from "../../../src/components/ui/icon.js";
import { QueueFlash } from "../../../src/components/ops/flash.js";
import { QueueRow } from "../../../src/components/ops/queue-row.js";
import { ActionForm, SubmitButton } from "../../../src/components/ops/action-form.js";
import { ReopenForm } from "../../../src/components/ops/reopen-form.js";

const FILL_FLASH: Readonly<Record<string, string>> = {
  claimed: "Claimed for fill. Open the workbench to continue.",
  lot_assigned: "Lot assigned.",
  label_printed: "Vial label sent to printer.",
  fill_completed: "Fill complete — order moved to final verification.",
  reopened: "Order reopened for fill rework.",
};

export default async function FillQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.FILL_START)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Production" title="Fill queue" />
        <PermissionDenied grant="fill.start" role="Pharmacy Technician" />
      </div>
    );
  }

  const canReopen = hasOperatorPermission(permissions, PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION);

  const queue = await listOrdersInBucketByCode({
    organizationId: session.tenancy.organizationId,
    bucketCode: "FILL",
  });
  const now = new Date();

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Production"
        title="Fill queue"
        description="Claim a PV1-approved order, then open the workbench to assign lots, print vial labels, and scan-complete the fill."
      />

      <QueueFlash params={params} messages={FILL_FLASH} />

      {!queue.bucketExists ? (
        <Banner tone="warning" title="FILL bucket not provisioned">
          Run <code>ProvisionDefaultBuckets</code> to create it for this organization.
        </Banner>
      ) : queue.rows.length === 0 ? (
        <EmptyState
          icon="fill"
          title="No orders waiting for fill"
          description="PV1-approved orders land here for the fill bench."
        />
      ) : (
        <ul className="space-y-3">
          {queue.rows.map((row) => {
            const isReady = row.currentStatus === "PV1_APPROVED_READY_FOR_FILL";
            const isInProgress = row.currentStatus === "FILL_IN_PROGRESS";
            const isBounced = row.currentStatus === "FINAL_VERIFICATION_REJECTED";
            const isMine = isInProgress && row.currentAssigneeUserId === session.operator.userId;
            const otherAssignee = isInProgress && !isMine ? row.currentAssigneeUserId : null;

            return (
              <li key={row.orderId}>
                <QueueRow
                  orderId={row.orderId}
                  externalOrderNumber={row.externalOrderNumber}
                  priority={row.priority}
                  status={row.currentStatus}
                  slaDeadlineAt={row.slaDeadlineAt}
                  receivedAt={row.receivedAt}
                  now={now}
                  assigneeUserId={otherAssignee}
                  note={
                    isBounced
                      ? "Bounced back from final verification. Open the order detail for the rejection reason, then reopen for fill rework."
                      : undefined
                  }
                  headerExtra={
                    isInProgress ? (
                      <Link
                        href={`/ops/fill/${row.orderId}`}
                        className={buttonClass({
                          variant: isMine ? "primary" : "secondary",
                          size: "sm",
                        })}
                      >
                        <Icon name="fill" size={14} />
                        {isMine ? "Open workbench" : "View workbench"}
                      </Link>
                    ) : undefined
                  }
                >
                  {isReady ? (
                    <ActionForm action={`/api/ops/orders/${row.orderId}/start-fill`}>
                      <SubmitButton icon="fill">Claim · Start fill</SubmitButton>
                    </ActionForm>
                  ) : null}

                  {isBounced && canReopen ? (
                    <ReopenForm
                      orderId={row.orderId}
                      reopenToState="FILL_IN_PROGRESS"
                      defaultReason={ReopenReason.FILL_REDO}
                      submitLabel="Reopen for fill"
                    />
                  ) : null}
                </QueueRow>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
