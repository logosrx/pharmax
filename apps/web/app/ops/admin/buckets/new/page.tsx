// /ops/admin/buckets/new — create a custom operational bucket.
//
// Posts to /api/ops/admin/buckets/create which dispatches CreateBucket
// and redirects back. Gate: `org.manage_buckets`.
//
// The form only offers the three assignable kinds and does not offer
// the reserved codes — but that is convenience, not enforcement. Every
// rule shown here is re-decided server-side by CreateBucket.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../../src/server/auth/resolve-tenancy.js";
import { listPharmacySites } from "../../../../../src/server/ops/list-pharmacy-sites.js";
import { PageHeader } from "../../../../../src/components/ui/page.js";
import { Card, CardContent } from "../../../../../src/components/ui/card.js";
import { Banner, PermissionDenied } from "../../../../../src/components/ui/feedback.js";
import { Field, Input, Select } from "../../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../../src/components/ui/button.js";
import { Icon } from "../../../../../src/components/ui/icon.js";
import { ActionForm, SubmitButton } from "../../../../../src/components/ops/action-form.js";

export default async function NewBucketPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly error?: string }>;
}) {
  const result = await resolveOperatorTenancyContext();
  if (!result.ok) return null;

  const permissions = await loadOperatorPermissions(result.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.ORG_MANAGE_BUCKETS)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="New bucket" />
        <PermissionDenied grant="org.manage_buckets" />
      </div>
    );
  }

  const sites = await listPharmacySites({ organizationId: result.tenancy.organizationId });
  const { error } = await searchParams;

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
        title="New bucket"
        description="A custom bucket is a queue operators move orders into by hand. The workflow engine will not route into it automatically — stage routing is fixed to the seven system buckets."
      />

      {typeof error === "string" && error.length > 0 ? (
        <Banner tone="danger">{error}</Banner>
      ) : null}

      <Card>
        <CardContent>
          <ActionForm action="/api/ops/admin/buckets/create" className="space-y-5">
            <Field
              label="Code"
              required
              help="SCREAMING_SNAKE, unique in this organization, and permanent — a bucket's code cannot be changed after creation. Codes reserved by the workflow engine (INBOX, TYPING, PV1, FILL, FINAL, SHIPPING, EMERGENCY) are rejected."
            >
              <Input
                name="code"
                required
                maxLength={64}
                placeholder="PRIOR_AUTH"
                className="font-mono"
              />
            </Field>

            <Field label="Display name" required help="What operators see on the queue rail.">
              <Input name="name" required maxLength={120} placeholder="Prior Authorization" />
            </Field>

            <Field
              label="Kind"
              required
              help="WORKFLOW and EMERGENCY are reserved: the first asserts engine routing that only system buckets get, the second feeds the emergency SLA report."
            >
              <Select name="kind" required defaultValue="CUSTOM">
                <option value="CUSTOM">CUSTOM — a general operational queue</option>
                <option value="HOLD">HOLD — work parked pending something external</option>
                <option value="EXCEPTION">EXCEPTION — work that fell out of the happy path</option>
              </Select>
            </Field>

            <Field
              label="Sort order"
              required
              help="Position on the queue rail. The system buckets sit at 10, 20, 30, 40, 50, 60, 70 — pick a number between two of them to slot in."
            >
              <Input
                name="sortOrder"
                required
                type="number"
                min={0}
                max={10000}
                defaultValue={100}
                className="font-mono"
              />
            </Field>

            <Field
              label="Site"
              help="Optional. Leave blank for an organization-wide bucket visible at every site."
            >
              <Select name="siteId" defaultValue="">
                <option value="">— organization-wide —</option>
                {sites.map((site) => (
                  <option key={site.siteId} value={site.siteId}>
                    {site.name} ({site.code})
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
              <Link
                href="/ops/admin/buckets"
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                Cancel
              </Link>
              <SubmitButton icon="check">Create bucket</SubmitButton>
            </div>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
