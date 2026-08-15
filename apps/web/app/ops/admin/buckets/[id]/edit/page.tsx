// /ops/admin/buckets/[id]/edit — edit a bucket.
//
// The form shape depends on `isSystem`, matching exactly what
// UpdateBucket will accept:
//
//   system  →  name + sortOrder. No kind field is rendered and the
//              code is shown read-only, because changing either would
//              break workflow routing or emergency SLA reporting.
//   custom  →  name + sortOrder + kind, minus the reserved kinds.
//
// The delete card is separated from the edit form so an operator
// cannot destroy a bucket while meaning to save a rename. It is hidden
// outright for system buckets (DeleteBucket refuses them) and disabled
// with an explanation when the bucket still holds orders.
//
// Gate: `org.manage_buckets`.

import Link from "next/link";
import { notFound } from "next/navigation";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../../src/server/auth/resolve-tenancy.js";
import { getBucketById } from "../../../../../../src/server/ops/list-buckets.js";
import { PageHeader } from "../../../../../../src/components/ui/page.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../../../../src/components/ui/card.js";
import { Badge } from "../../../../../../src/components/ui/badge.js";
import { Banner, PermissionDenied } from "../../../../../../src/components/ui/feedback.js";
import { Field, Input, Select } from "../../../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../../../src/components/ui/button.js";
import { Icon } from "../../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../../src/components/ops/action-form.js";

export default async function EditBucketPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<{ readonly flash?: string; readonly error?: string }>;
}) {
  const { id } = await params;
  const { flash, error } = await searchParams;

  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.ORG_MANAGE_BUCKETS)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Edit bucket" />
        <PermissionDenied grant="org.manage_buckets" />
      </div>
    );
  }

  const row = await getBucketById({ tenancy: result.tenancy, bucketId: id });
  if (row === null) notFound();

  const holdsOrders = row.orderCount > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6 animate-fade-in">
      <Link
        href="/ops/admin/buckets"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <Icon name="arrowLeft" size={15} />
        Back to buckets
      </Link>

      <PageHeader
        eyebrow="Administration"
        title={row.name}
        description={
          <span>
            Code <code>{row.code}</code> — {row.orderCount} order
            {row.orderCount === 1 ? "" : "s"} currently in this bucket
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{row.kind}</Badge>
            {row.isSystem ? <Badge tone="neutral">system</Badge> : null}
          </div>
        }
      />

      {typeof flash === "string" && flash.length > 0 ? (
        <Banner tone="success">{flash}</Banner>
      ) : null}
      {typeof error === "string" && error.length > 0 ? (
        <Banner tone="danger">{error}</Banner>
      ) : null}

      {row.isSystem ? (
        <Banner tone="info">
          This is a system bucket. The workflow engine routes orders into it by code on every stage
          transition, and its kind drives emergency SLA reporting — so only the display name and
          sort order can be changed here.
        </Banner>
      ) : null}

      <Card>
        <CardContent>
          <ActionForm action={`/api/ops/admin/buckets/${row.id}/update`} className="space-y-5">
            <Field
              label="Code"
              help="Permanent. The workflow engine and saved views resolve buckets by code, so it is never editable — create a new bucket and move the orders instead."
            >
              <Input name="codeDisplay" defaultValue={row.code} disabled className="font-mono" />
            </Field>

            <Field label="Display name" required>
              <Input name="name" required maxLength={120} defaultValue={row.name} />
            </Field>

            {row.isSystem ? null : (
              <Field label="Kind" required>
                <Select name="kind" required defaultValue={row.kind}>
                  <option value="CUSTOM">CUSTOM — a general operational queue</option>
                  <option value="HOLD">HOLD — work parked pending something external</option>
                  <option value="EXCEPTION">
                    EXCEPTION — work that fell out of the happy path
                  </option>
                </Select>
              </Field>
            )}

            <Field label="Sort order" required help="Position on the queue rail.">
              <Input
                name="sortOrder"
                required
                type="number"
                min={0}
                max={10000}
                defaultValue={row.sortOrder}
                className="font-mono"
              />
            </Field>

            <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
              <Link
                href="/ops/admin/buckets"
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                Cancel
              </Link>
              <SubmitButton icon="check">Save changes</SubmitButton>
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      {row.isSystem ? null : (
        <Card accent="danger">
          <CardHeader>
            <CardTitle className="text-tone-danger">Delete bucket</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-md text-xs text-muted">
              {holdsOrders ? (
                <>
                  This bucket holds {row.orderCount} order{row.orderCount === 1 ? "" : "s"}. Move
                  them to another bucket first — deletion is refused while anything references it.
                </>
              ) : (
                <>
                  Permanently removes the bucket. There is no archive state, so this cannot be
                  undone — but the audit trail and the deletion event are preserved.
                </>
              )}
            </p>
            {holdsOrders ? (
              <span className={buttonClass({ variant: "danger", size: "sm" }) + " opacity-50"}>
                Delete
              </span>
            ) : (
              <ActionForm
                action={`/api/ops/admin/buckets/${row.id}/delete`}
                confirm={`Delete bucket ${row.code}? This cannot be undone.`}
              >
                <SubmitButton variant="danger" icon="x">
                  Delete
                </SubmitButton>
              </ActionForm>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
