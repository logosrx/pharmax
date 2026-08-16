// /ops/admin/compound-batches/[batchId] — batch detail + lifecycle.
//
// One production run: identity (batch number, barcode value, serial
// range), the quality dates (compounded, BUD), and the lifecycle
// actions the CURRENT status allows:
//
//   COMPOUNDED → "Send to testing"        (inventory.batch.transition)
//   TESTING    → "Release" / "Reject"     (inventory.batch.release)
//   RELEASED   → "Start dispensing"       (inventory.batch.transition)
//
// Actions post to /api/ops/inventory/compound-batch-transition; the
// commands enforce status guards, RBAC, BUD, and the one-dispensing-
// batch invariant — the page only offers what should be possible.
//
// Permission gate: `inventory.read` to view. Catalog/inventory data
// only — no PHI on this page.

import Link from "next/link";

import { CompoundBatchStatus } from "@pharmax/database";
import { COMPOUND_BATCH_REJECTION_REASONS } from "@pharmax/inventory";
import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { getCompoundBatch } from "../../../../../src/server/ops/get-compound-batch.js";
import { PageHeader, Section } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Badge, type Tone } from "../../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { buttonClass } from "../../../../../src/components/ui/button.js";
import { Field, Input, Select } from "../../../../../src/components/ui/field.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";

const STATUS_TONES: Record<CompoundBatchStatus, Tone> = {
  [CompoundBatchStatus.COMPOUNDED]: "neutral",
  [CompoundBatchStatus.TESTING]: "warning",
  [CompoundBatchStatus.RELEASED]: "success",
  [CompoundBatchStatus.DISPENSING]: "success",
  [CompoundBatchStatus.REJECTED]: "danger",
};

const REASON_LABELS: Readonly<Record<string, string>> = {
  POTENCY_OUT_OF_SPEC: "Potency out of specification",
  STERILITY_FAILURE: "Sterility failure",
  ENDOTOXIN_FAILURE: "Endotoxin failure",
  PARTICULATE_MATTER: "Particulate matter",
  CONTAMINATION: "Contamination",
  PH_OUT_OF_RANGE: "pH out of range",
  LABELING_ERROR: "Labeling error",
  OTHER: "Other (describe in note)",
};

function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function DetailItem({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export default async function CompoundBatchDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly batchId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ batchId }, sp] = await Promise.all([params, searchParams]);
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.INVENTORY_READ)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Compound batch" />
        <PermissionDenied grant="inventory.read" />
      </div>
    );
  }

  const batch = await getCompoundBatch({
    organizationId: session.tenancy.organizationId,
    batchId,
  });

  if (batch === null) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Directory" title="Batch not found" />
        <EmptyState
          icon="batches"
          title="This compound batch doesn't exist in your organization"
          action={
            <Link
              href="/ops/admin/compound-batches"
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              Back to compound batches
            </Link>
          }
        />
      </div>
    );
  }

  const flash = typeof sp["flash"] === "string" ? sp["flash"] : null;
  const flashError = typeof sp["error"] === "string" ? sp["error"] : null;
  const canTransition = hasOperatorPermission(permissions, PERMISSIONS.INVENTORY_BATCH_TRANSITION);
  const canRelease = hasOperatorPermission(permissions, PERMISSIONS.INVENTORY_BATCH_RELEASE);

  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/compound-batches"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to compound batches
      </Link>

      <PageHeader
        eyebrow="Compound batch"
        title={<span className="font-mono">{batch.batchNumber}</span>}
        description={`${batch.productName}${batch.productStrength !== null ? ` ${batch.productStrength}` : ""} — batch ${batch.daySequence} of ${formatDay(batch.compoundedOn)} at ${batch.siteCode}.`}
        actions={
          <div className="flex items-center gap-1.5">
            <Badge tone={STATUS_TONES[batch.status]}>{batch.status}</Badge>
            {batch.pastBud ? <Badge tone="danger">PAST BUD</Badge> : null}
          </div>
        }
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="Action failed">
          {flashError}
        </Banner>
      ) : null}
      {batch.status === CompoundBatchStatus.REJECTED ? (
        <Banner tone="danger" title="Batch rejected by the testing lab">
          Reason: {REASON_LABELS[batch.rejectionReasonCode ?? ""] ?? batch.rejectionReasonCode}. A
          rejected batch is terminal — its units must never be dispensed.
        </Banner>
      ) : null}

      <Section title="Identity">
        <Card>
          <CardContent>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <DetailItem label="Pharmax Product ID">
                <span className="font-mono">{batch.pharmaxProductId ?? "—"}</span>
              </DetailItem>
              <DetailItem label="Barcode value">
                <span className="font-mono">{batch.barcodeValue}</span>
              </DetailItem>
              <DetailItem label="Site">
                <span className="font-mono">{batch.siteCode}</span>{" "}
                <span className="text-muted">{batch.siteName}</span>
              </DetailItem>
              <DetailItem label="Units">
                <span className="font-mono">{batch.unitCount}</span>
                {batch.productUnitKind !== null ? (
                  <span className="text-muted"> {batch.productUnitKind.toLowerCase()}s</span>
                ) : null}
              </DetailItem>
              <DetailItem label="Serial range">
                <span className="font-mono">{batch.firstSerial}</span>
                {" … "}
                <span className="font-mono">{batch.lastSerial}</span>
              </DetailItem>
              <DetailItem label="Compounded on">
                <span className="font-mono">{formatDay(batch.compoundedOn)}</span>
              </DetailItem>
              <DetailItem label="Beyond-Use Date">
                <span className={batch.pastBud ? "font-mono text-tone-danger" : "font-mono"}>
                  {formatDay(batch.beyondUseDate)}
                </span>
              </DetailItem>
              <DetailItem label="Status since">
                <span className="font-mono">
                  {batch.statusChangedAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
              </DetailItem>
            </dl>
          </CardContent>
        </Card>
      </Section>

      {batch.status === CompoundBatchStatus.COMPOUNDED && canTransition ? (
        <Section title="Send to testing">
          <Card>
            <CardContent>
              <p className="mb-3 text-sm text-muted">
                Mark this batch as shipped to the independent testing lab. It becomes eligible for
                release (or rejection) once the lab reports back.
              </p>
              <ActionForm action="/api/ops/inventory/compound-batch-transition">
                <input type="hidden" name="action" value="send_to_testing" />
                <input type="hidden" name="batchId" value={batch.batchId} />
                <SubmitButton variant="go" icon="arrowRight">
                  Send to testing
                </SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
        </Section>
      ) : null}

      {batch.status === CompoundBatchStatus.TESTING && canRelease ? (
        <Section title="Record the lab's verdict">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardContent>
                <p className="mb-3 text-sm text-muted">
                  The lab passed this batch — release it for dispensing.
                </p>
                <ActionForm
                  action="/api/ops/inventory/compound-batch-transition"
                  className="space-y-3"
                >
                  <input type="hidden" name="action" value="release" />
                  <input type="hidden" name="batchId" value={batch.batchId} />
                  <Field
                    label="Lab reference"
                    help="Optional CoA / report number for the audit record"
                  >
                    <Input name="labReference" maxLength={300} className="font-mono" />
                  </Field>
                  <SubmitButton variant="go" icon="check">
                    Release batch
                  </SubmitButton>
                </ActionForm>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <p className="mb-3 text-sm text-muted">
                  The lab failed this batch — reject it. Rejection is terminal and requires a
                  reason.
                </p>
                <ActionForm
                  action="/api/ops/inventory/compound-batch-transition"
                  className="space-y-3"
                >
                  <input type="hidden" name="action" value="reject" />
                  <input type="hidden" name="batchId" value={batch.batchId} />
                  <Field label="Reason">
                    <Select name="reasonCode" required>
                      {COMPOUND_BATCH_REJECTION_REASONS.map((reason) => (
                        <option key={reason} value={reason}>
                          {REASON_LABELS[reason] ?? reason}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Note" help="Optional detail for the audit record">
                    <Input name="note" maxLength={1000} />
                  </Field>
                  <SubmitButton variant="danger" icon="x">
                    Reject batch
                  </SubmitButton>
                </ActionForm>
              </CardContent>
            </Card>
          </div>
        </Section>
      ) : null}

      {batch.status === CompoundBatchStatus.RELEASED && canTransition ? (
        <Section title="Start dispensing">
          <Card>
            <CardContent>
              {batch.pastBud ? (
                <p className="text-sm text-tone-danger">
                  This batch is past its Beyond-Use Date and can no longer become the dispensing
                  batch.
                </p>
              ) : (
                <>
                  <p className="mb-3 text-sm text-muted">
                    Make this the batch that orders for{" "}
                    <span className="font-medium">{batch.productName}</span> fill from at{" "}
                    <span className="font-mono">{batch.siteCode}</span>. If another batch is
                    currently dispensing, it moves back to RELEASED.
                  </p>
                  <ActionForm action="/api/ops/inventory/compound-batch-transition">
                    <input type="hidden" name="action" value="start_dispensing" />
                    <input type="hidden" name="batchId" value={batch.batchId} />
                    <SubmitButton variant="go" icon="check">
                      Start dispensing
                    </SubmitButton>
                  </ActionForm>
                </>
              )}
            </CardContent>
          </Card>
        </Section>
      ) : null}

      <div className="text-sm text-muted">
        <Link
          href={`/ops/admin/compound-batches?productId=${batch.productId}`}
          className="text-brand hover:underline"
        >
          View sibling batches of this compound
        </Link>
      </div>
    </div>
  );
}
