// /ops/typing — typist intake / typing queue.
//
// The typing flow spans two buckets:
//   - INBOX: RECEIVED orders awaiting a typist to claim.
//   - TYPING: TYPING_IN_PROGRESS (being worked),
//     TYPING_PENDING_MISSING_INFO (missing-info hold), and
//     PV1_REJECTED (bounced back from PV1 for rework).
//
// Rendered as three sections — claim new work, finish in-progress
// work, and handle exceptions — so a typist has one screen for their
// whole day. PHI: the queue surface is non-PHI; the order-detail page
// is where the typist reads patient + Rx data.

import { ReopenReason } from "@pharmax/database";
import { PERMISSIONS } from "@pharmax/rbac";
import { MISSING_INFO_REASONS } from "@pharmax/verification";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../src/server/auth/resolve-tenancy.js";
import {
  listOrdersInBucketsByCode,
  type BucketOrderRow,
} from "../../../src/server/ops/list-orders-in-bucket.js";
import { PageHeader, Section } from "../../../src/components/ui/page.js";
import { EmptyState, PermissionDenied, Banner } from "../../../src/components/ui/feedback.js";
import { Field, Select } from "../../../src/components/ui/field.js";
import { QueueFlash } from "../../../src/components/ops/flash.js";
import { QueueRow } from "../../../src/components/ops/queue-row.js";
import { ActionForm, SubmitButton } from "../../../src/components/ops/action-form.js";
import { ReopenForm } from "../../../src/components/ops/reopen-form.js";

const TYPING_FLASH: Readonly<Record<string, string>> = {
  claimed: "Claimed for typing.",
  completed: "Typing review complete — order moved to PV1.",
  marked_missing: "Marked as pending missing info. Resume when the info is back.",
  resumed: "Resumed typing.",
  reopened: "Order reopened for correction.",
};

interface RowProps {
  readonly row: BucketOrderRow;
  readonly now: Date;
  readonly operatorUserId: string;
  readonly canComplete: boolean;
  readonly canStart: boolean;
  readonly canMarkMissingInfo: boolean;
  readonly canReopen: boolean;
}

function TypingRow({
  row,
  now,
  operatorUserId,
  canComplete,
  canStart,
  canMarkMissingInfo,
  canReopen,
}: RowProps) {
  const isReady = row.currentStatus === "RECEIVED";
  const isInProgress = row.currentStatus === "TYPING_IN_PROGRESS";
  const isPending = row.currentStatus === "TYPING_PENDING_MISSING_INFO";
  const isBounced = row.currentStatus === "PV1_REJECTED";
  const isMine = isInProgress && row.currentAssigneeUserId === operatorUserId;
  const otherAssignee = isInProgress && !isMine ? row.currentAssigneeUserId : null;

  return (
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
          ? "Bounced back from PV1. Open the order detail for the rejection reason, then reopen with corrections."
          : isPending
            ? "Pending missing info. Resolve the gap (patient, prescriber, or sig) and resume typing."
            : undefined
      }
    >
      {isReady && canStart ? (
        <ActionForm action={`/api/ops/orders/${row.orderId}/start-typing`}>
          <SubmitButton icon="typing">Claim · Start typing</SubmitButton>
        </ActionForm>
      ) : null}

      {isMine && canComplete ? (
        <ActionForm action={`/api/ops/orders/${row.orderId}/complete-typing-review`}>
          <SubmitButton variant="go" icon="arrowRight">
            Complete review · to PV1
          </SubmitButton>
        </ActionForm>
      ) : null}

      {isMine && canMarkMissingInfo ? (
        <ActionForm
          action={`/api/ops/orders/${row.orderId}/mark-typing-missing-info`}
          className="flex flex-wrap items-end gap-2"
        >
          <Field label="Missing info reason">
            <Select name="reasonCode" defaultValue={MISSING_INFO_REASONS[0]}>
              {MISSING_INFO_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <SubmitButton variant="secondary" icon="hold">
            Pause · missing info
          </SubmitButton>
        </ActionForm>
      ) : null}

      {isPending && canStart ? (
        <ActionForm action={`/api/ops/orders/${row.orderId}/resume-typing`}>
          <SubmitButton icon="typing">Resume typing</SubmitButton>
        </ActionForm>
      ) : null}

      {isBounced && canReopen ? (
        <ReopenForm
          orderId={row.orderId}
          reopenToState="TYPING_IN_PROGRESS"
          defaultReason={ReopenReason.PV1_REWORK}
          submitLabel="Reopen for typing"
        />
      ) : null}
    </QueueRow>
  );
}

export default async function TypingQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.TYPING_START)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Intake" title="Typing queue" />
        <PermissionDenied grant="typing.start" role="Typist" />
      </div>
    );
  }

  const canComplete = hasOperatorPermission(permissions, PERMISSIONS.TYPING_COMPLETE);
  const canStart = hasOperatorPermission(permissions, PERMISSIONS.TYPING_START);
  const canMarkMissingInfo = hasOperatorPermission(
    permissions,
    PERMISSIONS.TYPING_MARK_MISSING_INFO
  );
  const canReopen = hasOperatorPermission(permissions, PERMISSIONS.ORDERS_REOPEN_FOR_CORRECTION);

  const buckets = await listOrdersInBucketsByCode({
    organizationId: session.tenancy.organizationId,
    bucketCodes: ["INBOX", "TYPING"],
  });
  const inbox = buckets["INBOX"]!;
  const typing = buckets["TYPING"]!;
  const now = new Date();

  const typingActive = typing.rows.filter((r) => r.currentStatus === "TYPING_IN_PROGRESS");
  const typingExceptions = typing.rows.filter((r) => r.currentStatus !== "TYPING_IN_PROGRESS");

  const rowProps = {
    now,
    operatorUserId: session.operator.userId,
    canComplete,
    canStart,
    canMarkMissingInfo,
    canReopen,
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Intake"
        title="Typing queue"
        description="Claim a new order from the inbox, finish what you're working, or address a PV1 bounce-back or missing-info hold."
      />

      <QueueFlash params={params} messages={TYPING_FLASH} />

      <Section title="Inbox" count={inbox.rows.length} aside="Ready to claim">
        {!inbox.bucketExists ? (
          <Banner tone="warning" title="INBOX bucket not provisioned">
            Run <code>ProvisionDefaultBuckets</code> to create it.
          </Banner>
        ) : inbox.rows.length === 0 ? (
          <EmptyState
            icon="typing"
            title="Inbox is empty"
            description="New orders arrive here for a typist to claim."
          />
        ) : (
          <ul className="space-y-3">
            {inbox.rows.map((row) => (
              <li key={row.orderId}>
                <TypingRow row={row} {...rowProps} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="In progress" count={typingActive.length} aside="Your active work">
        {typingActive.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing in progress"
            description="Claim an order from the inbox to start typing."
          />
        ) : (
          <ul className="space-y-3">
            {typingActive.map((row) => (
              <li key={row.orderId}>
                <TypingRow row={row} {...rowProps} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {typingExceptions.length > 0 ? (
        <Section
          title="Exceptions"
          count={typingExceptions.length}
          tone="warning"
          aside="Bounce-back · missing info"
        >
          <ul className="space-y-3">
            {typingExceptions.map((row) => (
              <li key={row.orderId}>
                <TypingRow row={row} {...rowProps} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
