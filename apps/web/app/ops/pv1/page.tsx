// /ops/pv1 — pharmacist PV1 queue.
//
// Lists orders currently in the PV1 bucket. Two row variants:
//
//   - TYPED_READY_FOR_PV1: anyone with `pv1.start` can "Claim" the
//     order to begin PV1 (StartPV1 → PV1_IN_PROGRESS, stamps the
//     operator as assignee).
//   - PV1_IN_PROGRESS: only the assignee can Approve / Reject (the
//     command-bus assignee guard enforces this); others see the row
//     read-only with "claimed by <other>".
//
// PHI: order rows are non-PHI; the order-detail page is the
// PHI-decrypting read a pharmacist opens before approving.

import { PERMISSIONS } from "@pharmax/rbac";
import { PV1_REJECTION_REASONS } from "@pharmax/verification";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { listOrdersInBucketByCode } from "../../../src/server/ops/list-orders-in-bucket.js";
import { PageHeader } from "../../../src/components/ui/page.js";
import { EmptyState, PermissionDenied, Banner } from "../../../src/components/ui/feedback.js";
import { Field, Select } from "../../../src/components/ui/field.js";
import { QueueFlash } from "../../../src/components/ops/flash.js";
import { QueueRow } from "../../../src/components/ops/queue-row.js";
import { ActionForm, SubmitButton } from "../../../src/components/ops/action-form.js";

const PV1_FLASH: Readonly<Record<string, string>> = {
  claimed: "Claimed for PV1.",
  approved: "Approved PV1 — order moved to the fill bucket.",
  rejected: "Rejected PV1 — order routed back to typing.",
};

export default async function Pv1QueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.PV1_START)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Verification" title="PV1 queue" />
        <PermissionDenied grant="pv1.start" role="Pharmacist" />
      </div>
    );
  }

  const canApprove = hasOperatorPermission(permissions, PERMISSIONS.PV1_APPROVE);
  const canReject = hasOperatorPermission(permissions, PERMISSIONS.PV1_REJECT);

  const queue = await listOrdersInBucketByCode({
    organizationId: session.tenancy.organizationId,
    bucketCode: "PV1",
  });
  const now = new Date();

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Verification"
        title="PV1 queue"
        description="Pharmacist verification. Claim a ready order to begin, or approve / reject the one you're working."
      />

      <QueueFlash params={params} messages={PV1_FLASH} />

      {!queue.bucketExists ? (
        <Banner tone="warning" title="PV1 bucket not provisioned">
          Run <code>ProvisionDefaultBuckets</code> to create it for this organization.
        </Banner>
      ) : queue.rows.length === 0 ? (
        <EmptyState
          icon="verify"
          title="No orders waiting for PV1"
          description="Approved typing lands here for pharmacist verification."
        />
      ) : (
        <ul className="space-y-3">
          {queue.rows.map((row) => {
            const isReady = row.currentStatus === "TYPED_READY_FOR_PV1";
            const isInProgress = row.currentStatus === "PV1_IN_PROGRESS";
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
                >
                  {isReady ? (
                    <ActionForm action={`/api/ops/orders/${row.orderId}/start-pv1`}>
                      <SubmitButton icon="verify">Claim · Start PV1</SubmitButton>
                    </ActionForm>
                  ) : null}

                  {isMine && canApprove ? (
                    <ActionForm action={`/api/ops/orders/${row.orderId}/approve-pv1`}>
                      <SubmitButton variant="go" icon="check">
                        Approve PV1
                      </SubmitButton>
                    </ActionForm>
                  ) : null}

                  {isMine && canReject ? (
                    <ActionForm
                      action={`/api/ops/orders/${row.orderId}/reject-pv1`}
                      className="flex flex-wrap items-end gap-2"
                    >
                      <Field label="Rejection reason">
                        <Select name="reasonCode" defaultValue="DOSE_INCORRECT">
                          {PV1_REJECTION_REASONS.map((reason) => (
                            <option key={reason} value={reason}>
                              {reason}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <SubmitButton variant="danger" icon="x">
                        Reject
                      </SubmitButton>
                    </ActionForm>
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
