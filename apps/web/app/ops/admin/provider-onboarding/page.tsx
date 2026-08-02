// /ops/admin/provider-onboarding — provider self-serve onboarding
// review queue (ADR-0033, slice 1).
//
// Two surfaces:
//   - Review queue: applications the automated NPPES proofing could
//     not cleanly verify (NEEDS_REVIEW, oldest first). The reviewer
//     approves with a reason code (creates the roster row) or
//     rejects with a reason code. Both are MFA-gated commands.
//   - Recent applications: submitted / auto-approved / rejected
//     history — the "is self-serve onboarding healthy" view.
//
// PHI: none. Applications carry the prescriber's public
// professional identity and the public NPPES proofing snapshot.

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import {
  listOnboardingApplications,
  type OnboardingApplicationRow,
} from "../../../../src/server/ops/list-onboarding-applications.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Input } from "../../../../src/components/ui/field.js";
import { Table, THead, TH, TBody, TR, TD } from "../../../../src/components/ui/data.js";
import { ActionForm, SubmitButton } from "../../../../src/components/ops/action-form.js";

function ts(d: Date | null): string {
  return d === null ? "—" : d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function StatusBadge({ status }: { readonly status: OnboardingApplicationRow["status"] }) {
  switch (status) {
    case "SUBMITTED":
      return <Badge tone="info">submitted</Badge>;
    case "NEEDS_REVIEW":
      return <Badge tone="warning">needs review</Badge>;
    case "APPROVED":
      return <Badge tone="success">approved</Badge>;
    case "REJECTED":
      return <Badge tone="danger">rejected</Badge>;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function ProofingBadge({
  outcome,
}: {
  readonly outcome: OnboardingApplicationRow["proofingOutcome"];
}) {
  if (outcome === null) return <span className="text-xs text-subtle">pending</span>;
  switch (outcome) {
    case "PASS":
      return <Badge tone="success">NPPES match</Badge>;
    case "NOT_FOUND":
      return <Badge tone="danger">NPI not found</Badge>;
    case "NOT_INDIVIDUAL":
      return <Badge tone="warning">org-type NPI</Badge>;
    case "DEACTIVATED":
      return <Badge tone="danger">NPI deactivated</Badge>;
    case "NAME_MISMATCH":
      return <Badge tone="warning">name mismatch</Badge>;
    case "ALREADY_REGISTERED":
      return <Badge tone="warning">already on roster</Badge>;
    case "REGISTRY_UNAVAILABLE":
      return <Badge tone="neutral">registry unavailable</Badge>;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

function ApplicantCell({ row }: { readonly row: OnboardingApplicationRow }) {
  return (
    <div className="space-y-0.5">
      <div className="text-sm text-fg">
        {row.lastName}, {row.firstName}
        {row.credential !== null ? (
          <span className="text-xs text-subtle"> {row.credential}</span>
        ) : null}
      </div>
      <div className="text-xs text-subtle">
        NPI <code className="font-mono">{row.npi}</code> · {row.email}
      </div>
    </div>
  );
}

function ReviewQueueTable({ rows }: { readonly rows: ReadonlyArray<OnboardingApplicationRow> }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Applicant</TH>
          <TH>Proofing</TH>
          <TH>Applied</TH>
          <TH className="sr-only">Actions</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.applicationId}>
            <TD>
              <ApplicantCell row={row} />
            </TD>
            <TD>
              <div className="space-y-0.5">
                <ProofingBadge outcome={row.proofingOutcome} />
                <div className="text-2xs text-subtle">{ts(row.proofedAt)}</div>
              </div>
            </TD>
            <TD>
              <span className="text-xs text-muted">{ts(row.createdAt)}</span>
            </TD>
            <TD className="text-right">
              <div className="flex flex-col items-end gap-2">
                <ActionForm
                  action="/api/ops/admin/provider-onboarding/approve"
                  confirm={`Approve ${row.firstName} ${row.lastName} (NPI ${row.npi}) onto the roster? You are attesting to identity the NPPES check could not verify.`}
                  className="flex items-center justify-end gap-2"
                >
                  <input type="hidden" name="applicationId" value={row.applicationId} />
                  <Input
                    type="text"
                    name="reasonCode"
                    required
                    maxLength={100}
                    placeholder="Reason code"
                    className="w-36"
                  />
                  <SubmitButton size="sm">Approve</SubmitButton>
                </ActionForm>
                <ActionForm
                  action="/api/ops/admin/provider-onboarding/reject"
                  confirm={`Reject the application from ${row.firstName} ${row.lastName} (NPI ${row.npi})? They may reapply later.`}
                  className="flex items-center justify-end gap-2"
                >
                  <input type="hidden" name="applicationId" value={row.applicationId} />
                  <Input
                    type="text"
                    name="reasonCode"
                    required
                    maxLength={100}
                    placeholder="Reason code"
                    className="w-36"
                  />
                  <SubmitButton variant="danger" size="sm">
                    Reject
                  </SubmitButton>
                </ActionForm>
              </div>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function RecentTable({ rows }: { readonly rows: ReadonlyArray<OnboardingApplicationRow> }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Applicant</TH>
          <TH>Status</TH>
          <TH>Proofing</TH>
          <TH>Decision</TH>
          <TH>Applied</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.applicationId}>
            <TD>
              <ApplicantCell row={row} />
            </TD>
            <TD>
              <StatusBadge status={row.status} />
            </TD>
            <TD>
              <ProofingBadge outcome={row.proofingOutcome} />
            </TD>
            <TD>
              <div className="space-y-0.5 text-xs text-muted">
                <div>
                  {row.decidedByEmail ??
                    (row.status === "APPROVED" && row.decidedAt !== null ? "automatic" : "—")}
                </div>
                {row.decisionReasonCode !== null ? (
                  <div className="text-2xs text-subtle">{row.decisionReasonCode}</div>
                ) : null}
                <div className="text-2xs text-subtle">{ts(row.decidedAt)}</div>
              </div>
            </TD>
            <TD>
              <span className="text-xs text-muted">{ts(row.createdAt)}</span>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export default async function ProviderOnboardingAdminPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.PROVIDERS_ONBOARDING_REVIEW)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Provider onboarding" />
        <PermissionDenied grant="providers.onboarding.review" />
      </div>
    );
  }

  const organizationId = session.tenancy.organizationId;
  const { reviewQueue, recent } = await listOnboardingApplications({ organizationId });
  const flash = typeof params["flash"] === "string" ? params["flash"] : null;
  const flashError = typeof params["error"] === "string" ? params["error"] : null;

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="Administration"
        title="Provider onboarding"
        description="Self-serve prescriber applications. Clean NPPES matches auto-approve onto the roster; everything else lands here for a human decision."
      />

      {flash !== null ? <Banner tone="success">{flash}</Banner> : null}
      {flashError !== null ? (
        <Banner tone="danger" title="That action didn't go through">
          {flashError}
        </Banner>
      ) : null}

      <Section title="Review queue" count={reviewQueue.length}>
        {reviewQueue.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing to review"
            description="Applications appear here only when the automated NPPES check can't cleanly verify the applicant."
          />
        ) : (
          <ReviewQueueTable rows={reviewQueue} />
        )}
      </Section>

      <Section title="Recent applications" count={recent.length}>
        {recent.length === 0 ? (
          <EmptyState
            icon="history"
            title="No applications yet"
            description="Prescribers apply via POST /api/portal/v1/onboarding/applications once the organization opts in."
          />
        ) : (
          <RecentTable rows={recent} />
        )}
      </Section>
    </div>
  );
}
