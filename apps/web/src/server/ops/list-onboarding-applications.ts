// Provider onboarding application projection — drives
// `/ops/admin/provider-onboarding` (ADR-0033).
//
// Two projections off one table: the open review queue
// (NEEDS_REVIEW, oldest first — it's a work queue) and the recent
// history (everything else, newest first — it's an audit view).
//
// PHI: none — applications carry public professional identity and
// the public NPPES proofing snapshot.
// Tenancy: explicit `organizationId` predicate on top of RLS scope.

import "server-only";

import {
  readInOrgScope,
  type ProviderOnboardingProofingOutcome,
  type ProviderOnboardingStatus,
} from "@pharmax/database";

export interface OnboardingApplicationRow {
  readonly applicationId: string;
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly credential: string | null;
  readonly email: string;
  readonly status: ProviderOnboardingStatus;
  readonly proofingOutcome: ProviderOnboardingProofingOutcome | null;
  readonly proofedAt: Date | null;
  readonly providerId: string | null;
  readonly decidedByEmail: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReasonCode: string | null;
  readonly createdAt: Date;
}

export interface ListOnboardingApplicationsResult {
  readonly reviewQueue: ReadonlyArray<OnboardingApplicationRow>;
  readonly recent: ReadonlyArray<OnboardingApplicationRow>;
}

const ROW_SELECT = {
  id: true,
  npi: true,
  firstName: true,
  lastName: true,
  credential: true,
  email: true,
  status: true,
  proofingOutcome: true,
  proofedAt: true,
  providerId: true,
  decidedAt: true,
  decisionReasonCode: true,
  createdAt: true,
  decidedByUser: { select: { email: true } },
} as const;

interface RawRow {
  readonly id: string;
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly credential: string | null;
  readonly email: string;
  readonly status: ProviderOnboardingStatus;
  readonly proofingOutcome: ProviderOnboardingProofingOutcome | null;
  readonly proofedAt: Date | null;
  readonly providerId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReasonCode: string | null;
  readonly createdAt: Date;
  readonly decidedByUser: { readonly email: string } | null;
}

function toRow(r: RawRow): OnboardingApplicationRow {
  return Object.freeze({
    applicationId: r.id,
    npi: r.npi,
    firstName: r.firstName,
    lastName: r.lastName,
    credential: r.credential,
    email: r.email,
    status: r.status,
    proofingOutcome: r.proofingOutcome,
    proofedAt: r.proofedAt,
    providerId: r.providerId,
    decidedByEmail: r.decidedByUser?.email ?? null,
    decidedAt: r.decidedAt,
    decisionReasonCode: r.decisionReasonCode,
    createdAt: r.createdAt,
  });
}

export async function listOnboardingApplications(options: {
  readonly organizationId: string;
  readonly recentLimit?: number;
}): Promise<ListOnboardingApplicationsResult> {
  const recentLimit = Math.min(options.recentLimit ?? 50, 200);

  return readInOrgScope(options.organizationId, async (tx) => {
    const [reviewQueue, recent] = await Promise.all([
      tx.providerOnboardingApplication.findMany({
        where: { organizationId: options.organizationId, status: "NEEDS_REVIEW" },
        select: ROW_SELECT,
        orderBy: { createdAt: "asc" },
        take: 200,
      }),
      tx.providerOnboardingApplication.findMany({
        where: {
          organizationId: options.organizationId,
          status: { in: ["SUBMITTED", "APPROVED", "REJECTED"] },
        },
        select: ROW_SELECT,
        orderBy: { createdAt: "desc" },
        take: recentLimit,
      }),
    ]);

    return Object.freeze({
      reviewQueue: reviewQueue.map(toRow),
      recent: recent.map(toRow),
    });
  });
}
