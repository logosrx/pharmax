// Public application-status page (ADR-0033, slice 2).
//
// `/portal/status?id=<applicationId>` — the id is the capability the
// applicant received in the submit response / confirmation. Renders
// the same tiny projection the status API returns (status +
// timestamps, never the identity-claim fields). Unknown/malformed
// ids get one generic not-found message.

import { z } from "zod";

import { AuthShell } from "../../../src/components/shell/auth-shell.js";
import { getPortalApplicationStatus } from "../../../src/server/portal/application-status.js";

const idSchema = z.uuid();

const STATUS_COPY: Record<string, { label: string; detail: string }> = {
  SUBMITTED: {
    label: "Submitted",
    detail: "Your application is queued for automated identity verification.",
  },
  NEEDS_REVIEW: {
    label: "In review",
    detail: "Your application is being reviewed by the pharmacy team.",
  },
  APPROVED: {
    label: "Approved",
    detail: "You're approved. Check your email for the portal account setup link.",
  },
  REJECTED: {
    label: "Not approved",
    detail: "This application was not approved. Contact the pharmacy for details.",
  },
};

export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  const parsed = idSchema.safeParse(id ?? "");
  const status = parsed.success ? await getPortalApplicationStatus(parsed.data) : null;

  return (
    <AuthShell title="Application status" subtitle="Provider onboarding">
      <div className="w-full space-y-4 rounded-lg border border-line bg-surface p-6">
        {status === null ? (
          <p className="text-sm text-muted">
            No application found for this link. Check the link from your submission confirmation, or
            contact the pharmacy.
          </p>
        ) : (
          <>
            <div className="space-y-1">
              <p className="text-lg font-semibold text-fg">
                {STATUS_COPY[status.status]?.label ?? status.status}
              </p>
              <p className="text-sm text-muted">{STATUS_COPY[status.status]?.detail ?? ""}</p>
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Submitted</dt>
                <dd className="text-fg">{status.submittedAt.toLocaleDateString("en-US")}</dd>
              </div>
              {status.decidedAt !== null ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">Decided</dt>
                  <dd className="text-fg">{status.decidedAt.toLocaleDateString("en-US")}</dd>
                </div>
              ) : null}
            </dl>
          </>
        )}
      </div>
    </AuthShell>
  );
}
