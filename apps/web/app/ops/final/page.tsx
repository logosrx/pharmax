// /ops/final — pharmacist FINAL VERIFICATION queue.
//
// The second pharmacist signature. Row variants:
//   - FILL_COMPLETED_READY_FOR_FINAL: `final.start` can claim
//     (StartFinalVerification → FINAL_VERIFICATION_IN_PROGRESS).
//   - FINAL_VERIFICATION_IN_PROGRESS: only the assignee sees
//     Approve / Reject. ApproveFinalVerification carries a
//     Separation-of-Duties guard at the bus that rejects an approval
//     by the same pharmacist who did PV1 — surfaced here as a hint;
//     the loud guard is the bus check on dispatch.
//
// PHI: the queue card shows the patient's name, so this page is a PHI
// surface. `attachQueueRowDetails` audits each distinct patient view
// before render and masks any name whose audit write failed, keeping the
// order itself visible. The order-detail page is still where the
// pharmacist reads the full patient + drug + sig before approving.

import { PERMISSIONS } from "@pharmax/rbac";
import { FINAL_REJECTION_REASONS } from "@pharmax/verification";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import { loadQueuePageData } from "../../../src/server/ops/load-queue-page-data.js";
import {
  buildQueueHref,
  parseQueueCursor,
  parseQueueFilters,
} from "../../../src/server/ops/queue-search-params.js";
import {
  QueuePager,
  QueuePhiNotice,
  QueueToolbar,
} from "../../../src/components/ops/queue-toolbar.js";
import { PageHeader } from "../../../src/components/ui/page.js";
import { EmptyState, PermissionDenied, Banner } from "../../../src/components/ui/feedback.js";
import { Field, Select } from "../../../src/components/ui/field.js";
import { QueueFlash } from "../../../src/components/ops/flash.js";
import { QueueLiveRefresher } from "../../../src/components/ops/queue-live-refresher.js";
import { QueueRow } from "../../../src/components/ops/queue-row.js";
import { ActionForm, SubmitButton } from "../../../src/components/ops/action-form.js";

const FINAL_FLASH: Readonly<Record<string, string>> = {
  claimed: "Claimed for final verification.",
  approved: "Approved — order moved to the shipping bucket.",
  rejected: "Rejected — order routed back to fill for rework.",
};

export default async function FinalQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.FINAL_START)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Verification" title="Final verification" />
        <PermissionDenied grant="final.start" role="Pharmacist" />
      </div>
    );
  }

  const canApprove = hasOperatorPermission(permissions, PERMISSIONS.FINAL_APPROVE);
  const canReject = hasOperatorPermission(permissions, PERMISSIONS.FINAL_REJECT);

  const filters = parseQueueFilters(params);
  const cursor = parseQueueCursor(params);
  const { queue, filterOptions, detailed } = await loadQueuePageData({
    organizationId: session.tenancy.organizationId,
    operatorUserId: session.operator.userId,
    bucketCode: "FINAL",
    filters,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const now = new Date();

  const hrefFor = (override: Readonly<Record<string, string | undefined>>) =>
    buildQueueHref({ basePath: "/ops/final", filters, override });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        eyebrow="Verification"
        title="Final verification"
        description="Second pharmacist signature. Claim a fill-completed order to verify, then approve to release for shipping or reject back to fill."
      />

      <QueueFlash params={params} messages={FINAL_FLASH} />
      <QueueLiveRefresher codes={["FINAL"]} />

      {queue.bucketExists ? (
        <QueueToolbar
          basePath="/ops/final"
          filters={filters}
          clinics={filterOptions.clinics}
          sites={filterOptions.sites}
          hrefFor={hrefFor}
          totalMatching={queue.totalMatching}
          shownCount={detailed.rows.length}
        />
      ) : null}

      <QueuePhiNotice
        withheldCount={detailed.patientNamesWithheld}
        decryptErrorCount={detailed.phiDecryptErrors}
      />

      {!queue.bucketExists ? (
        <Banner tone="warning" title="FINAL bucket not provisioned">
          Run <code>ProvisionDefaultBuckets</code> to create it for this organization.
        </Banner>
      ) : detailed.rows.length === 0 ? (
        <EmptyState
          icon="final"
          title={
            queue.totalMatching === 0
              ? "No orders waiting for final verification"
              : "No orders match"
          }
          description={
            queue.totalMatching === 0
              ? "Nothing awaits the second signature — completed fills land here for the final pharmacist check."
              : "Every order in this bucket is filtered out. Clear the filters to see the full queue."
          }
          hint="The queue refreshes live; new arrivals appear without a reload."
        />
      ) : (
        <ul className="space-y-3">
          {detailed.rows.map((row) => {
            const isReady = row.currentStatus === "FILL_COMPLETED_READY_FOR_FINAL";
            const isInProgress = row.currentStatus === "FINAL_VERIFICATION_IN_PROGRESS";
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
                  clinicCode={row.clinicCode}
                  clinicName={row.clinicName}
                  patientName={row.patientName}
                  patientNameWithheld={row.patientNameWithheld}
                  prescribers={row.prescribers}
                  medications={row.medications}
                  note={
                    isMine
                      ? "Separation of duties: if you also performed PV1 on this order, approval will be rejected at the command bus. Reject and route to another pharmacist if needed."
                      : undefined
                  }
                >
                  {isReady ? (
                    <ActionForm action={`/api/ops/orders/${row.orderId}/start-final`}>
                      <SubmitButton icon="final">Claim · Start verification</SubmitButton>
                    </ActionForm>
                  ) : null}

                  {isMine && canApprove ? (
                    <ActionForm action={`/api/ops/orders/${row.orderId}/approve-final`}>
                      <SubmitButton variant="go" icon="check">
                        Approve final
                      </SubmitButton>
                    </ActionForm>
                  ) : null}

                  {isMine && canReject ? (
                    <ActionForm
                      action={`/api/ops/orders/${row.orderId}/reject-final`}
                      className="flex flex-wrap items-end gap-2"
                    >
                      <Field label="Rejection reason">
                        <Select name="reasonCode" defaultValue={FINAL_REJECTION_REASONS[0]}>
                          {FINAL_REJECTION_REASONS.map((reason) => (
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

      <QueuePager
        nextHref={queue.nextCursor === null ? null : hrefFor({ cursor: queue.nextCursor })}
        shownCount={detailed.rows.length}
        totalMatching={queue.totalMatching}
      />
    </div>
  );
}
