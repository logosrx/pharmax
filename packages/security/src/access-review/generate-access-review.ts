// Quarterly access review report generator.
//
// SOC 2 CC6.2 requires periodic (typically quarterly) review of who
// has access to what. This module produces a JSON-serializable
// snapshot of all (user → role → scope → permission) assignments for
// one organization at a point in time, plus a reviewer's-eye summary
// highlighting:
//
//   - Principals with elevated roles (matching `ELEVATED_ROLE_CODES`).
//   - Principals who have not authenticated recently (90-day threshold,
//     wired against Clerk sessions — currently a TODO until the Clerk
//     events sync lands).
//   - Stale role assignments older than `STALE_ASSIGNMENT_THRESHOLD_DAYS`
//     that should be re-justified.
//
// The output is intended to be:
//
//   - committed to a SOC 2 evidence repository per-quarter,
//   - imported into a Notion / Confluence page for the human reviewer
//     to sign off on,
//   - diffed against the prior quarter's report to surface changes.
//
// PHI invariant: this report contains user identifiers, role codes,
// and tenancy scope ids. It does NOT contain patient identifiers,
// patient PHI, or session tokens. Any future expansion to include
// audit-log slices must re-check this guarantee.

import { PERMISSION_METADATA, type PermissionCode } from "@pharmax/rbac";

/** Role codes treated as "elevated" for review highlighting purposes. */
export const ELEVATED_ROLE_CODES: ReadonlyArray<string> = Object.freeze([
  "OrgAdmin",
  "Pharmacist",
  "BillingManager",
  "SecurityOfficer",
  "ComplianceOfficer",
  "PharmacistInCharge",
]);

/** A role assignment older than this many days is flagged for re-justification. */
export const STALE_ASSIGNMENT_THRESHOLD_DAYS = 365;

/** A user with no login in this many days is flagged as inactive. */
export const INACTIVE_USER_THRESHOLD_DAYS = 90;

export interface AccessReviewReport {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly generatedAt: string;
  readonly period: { readonly start: string; readonly end: string };
  readonly principals: ReadonlyArray<AccessReviewPrincipal>;
  readonly summary: AccessReviewSummary;
}

export interface AccessReviewPrincipal {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: string;
  readonly clerkUserId: string | null;
  readonly lastLoginAt: string | null;
  readonly assignments: ReadonlyArray<AccessReviewAssignment>;
  readonly effectivePermissions: ReadonlyArray<PermissionCode>;
}

export interface AccessReviewAssignment {
  readonly userRoleId: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly scope: "ORGANIZATION" | "SITE" | "CLINIC" | "TEAM";
  readonly organizationId: string;
  readonly siteId: string | null;
  readonly clinicId: string | null;
  readonly teamId: string | null;
  readonly grantedAt: string;
  readonly isElevated: boolean;
  readonly ageDays: number;
}

export interface AccessReviewSummary {
  readonly totalPrincipals: number;
  readonly principalsWithElevatedRoles: ReadonlyArray<string>;
  /** Principals whose `lastLoginAt` is older than `INACTIVE_USER_THRESHOLD_DAYS` (or unknown). */
  readonly inactivePrincipals: ReadonlyArray<string>;
  /** Assignments older than `STALE_ASSIGNMENT_THRESHOLD_DAYS`. */
  readonly staleAssignments: ReadonlyArray<{
    readonly userId: string;
    readonly userRoleId: string;
    readonly roleCode: string;
    readonly ageDays: number;
  }>;
  /** Roles in the report that grant `patients.crypto_shred` (highest-blast-radius permission). */
  readonly cryptoShredCapableRoles: ReadonlyArray<string>;
}

/**
 * Repository-shaped port the generator depends on. Production wires
 * a Prisma-backed implementation; tests inject a fake.
 */
export interface AccessReviewClient {
  loadOrganization(args: { readonly organizationId: string }): Promise<{
    readonly id: string;
    readonly slug: string;
  } | null>;

  loadUsersWithRoles(args: { readonly organizationId: string }): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly email: string;
      readonly displayName: string;
      readonly status: string;
      readonly clerkUserId: string | null;
      readonly lastLoginAt: Date | null;
      readonly userRoles: ReadonlyArray<{
        readonly id: string;
        readonly createdAt: Date;
        readonly organizationId: string;
        readonly siteId: string | null;
        readonly clinicId: string | null;
        readonly teamId: string | null;
        readonly role: {
          readonly id: string;
          readonly code: string;
          readonly name: string;
          readonly scope: "ORGANIZATION" | "SITE" | "CLINIC" | "TEAM";
          readonly rolePermissions: ReadonlyArray<{
            readonly permission: { readonly code: string };
          }>;
        };
      }>;
    }>
  >;
}

export interface GenerateAccessReviewInput {
  readonly organizationId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly client: AccessReviewClient;
  /** Override the "now" timestamp; defaults to `new Date()`. */
  readonly now?: Date;
}

export class OrganizationNotFoundForAccessReviewError extends Error {
  public constructor(organizationId: string) {
    super(`Organization ${organizationId} not found for access review.`);
    this.name = "OrganizationNotFoundForAccessReviewError";
  }
}

export async function generateAccessReview(
  input: GenerateAccessReviewInput
): Promise<AccessReviewReport> {
  const now = input.now ?? new Date();
  if (
    !(input.periodStart instanceof Date) ||
    !(input.periodEnd instanceof Date) ||
    Number.isNaN(input.periodStart.getTime()) ||
    Number.isNaN(input.periodEnd.getTime()) ||
    input.periodEnd.getTime() <= input.periodStart.getTime()
  ) {
    throw new TypeError("generateAccessReview: periodEnd must be strictly after periodStart.");
  }

  const org = await input.client.loadOrganization({ organizationId: input.organizationId });
  if (org === null) {
    throw new OrganizationNotFoundForAccessReviewError(input.organizationId);
  }

  const users = await input.client.loadUsersWithRoles({ organizationId: input.organizationId });

  const principals: AccessReviewPrincipal[] = [];
  const elevatedPrincipals: string[] = [];
  const inactivePrincipals: string[] = [];
  const staleAssignments: AccessReviewSummary["staleAssignments"][number][] = [];
  const cryptoShredRoles = new Set<string>();

  const knownPermissions = new Set<string>(Object.keys(PERMISSION_METADATA));

  for (const user of users) {
    const assignments: AccessReviewAssignment[] = [];
    const effective = new Set<string>();
    let isElevated = false;

    for (const userRole of user.userRoles) {
      const grantedAt = userRole.createdAt;
      const ageDays = daysBetween(grantedAt, now);
      const elevated = ELEVATED_ROLE_CODES.includes(userRole.role.code);
      if (elevated) isElevated = true;

      for (const rp of userRole.role.rolePermissions) {
        const code = rp.permission.code;
        if (knownPermissions.has(code)) {
          effective.add(code);
          if (code === "patients.crypto_shred") {
            cryptoShredRoles.add(userRole.role.code);
          }
        }
      }

      if (ageDays >= STALE_ASSIGNMENT_THRESHOLD_DAYS) {
        staleAssignments.push({
          userId: user.id,
          userRoleId: userRole.id,
          roleCode: userRole.role.code,
          ageDays,
        });
      }

      assignments.push({
        userRoleId: userRole.id,
        roleCode: userRole.role.code,
        roleName: userRole.role.name,
        scope: userRole.role.scope,
        organizationId: userRole.organizationId,
        siteId: userRole.siteId,
        clinicId: userRole.clinicId,
        teamId: userRole.teamId,
        grantedAt: grantedAt.toISOString(),
        isElevated: elevated,
        ageDays,
      });
    }

    const lastLoginAtIso = user.lastLoginAt === null ? null : user.lastLoginAt.toISOString();
    const inactive =
      user.lastLoginAt === null
        ? true
        : daysBetween(user.lastLoginAt, now) >= INACTIVE_USER_THRESHOLD_DAYS;

    if (isElevated) elevatedPrincipals.push(user.id);
    if (inactive && assignments.length > 0) inactivePrincipals.push(user.id);

    principals.push({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      clerkUserId: user.clerkUserId,
      lastLoginAt: lastLoginAtIso,
      assignments,
      effectivePermissions: Array.from(effective).sort() as ReadonlyArray<PermissionCode>,
    });
  }

  // TODO(Clerk sync): when `clerk.session.created.v1` outbox handler
  // is wired, replace `lastLoginAt` (Pharmax user row) with the most
  // recent Clerk session-created event timestamp. The Pharmax field
  // is only updated on a successful sign-in callback today, which
  // may lag behind Clerk's actual session creation by some minutes.

  return {
    organizationId: org.id,
    organizationSlug: org.slug,
    generatedAt: now.toISOString(),
    period: {
      start: input.periodStart.toISOString(),
      end: input.periodEnd.toISOString(),
    },
    principals,
    summary: {
      totalPrincipals: principals.length,
      principalsWithElevatedRoles: elevatedPrincipals,
      inactivePrincipals,
      staleAssignments,
      cryptoShredCapableRoles: Array.from(cryptoShredRoles).sort(),
    },
  };
}

function daysBetween(earlier: Date, later: Date): number {
  const ms = later.getTime() - earlier.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
