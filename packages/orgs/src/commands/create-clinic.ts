// CreateClinic — onboard a client practice.
//
// Why this command exists. `Clinic` has been in the schema since the
// phase-2 migration and is referenced by `patient`, `prescription`,
// `order`, `invoice`, `pricing_rule` and `bucket` — but until now the
// only code in the repository that INSERTed one was `prisma/seed.ts`.
// Onboarding a real customer's practice meant a hand-written INSERT:
// no RBAC check, no audit row, no event, no idempotency. This closes
// the same class of gap that `CreatePrescription` closed at intake.
//
// A clinic is the product's "client": the billing counterparty and the
// patient-roster boundary. Creating one admits a new counterparty to
// the organization, which is why it carries its own permission rather
// than riding on `org.manage_sites`.
//
// Guards, in the order they fire:
//   1. `code` shape — schema boundary.
//   2. Every supplied site belongs to the actor's org.
//   3. `(organizationId, code)` uniqueness — P2002 mapped to a domain
//      conflict so a double-submitted form reads as one.
//
// At least one site is REQUIRED. A clinic no site can fill for cannot
// receive an order, so allowing one to be created would only produce a
// row that looks onboarded and silently is not. The first id in
// `siteIds` becomes the primary link.
//
// `status` is NOT an input: a newly onboarded client is ACTIVE.
// Creating one pre-deactivated has no use case and would give the
// status field two writers.
//
// PHI: none. Directory metadata and ids only.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { ClinicStatus, Prisma } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const CREATE_CLINIC_CODE_ALREADY_EXISTS = "CREATE_CLINIC_CODE_ALREADY_EXISTS";
export const CREATE_CLINIC_SITE_NOT_IN_ORG = "CREATE_CLINIC_SITE_NOT_IN_ORG";
export const CREATE_CLINIC_DUPLICATE_SITE = "CREATE_CLINIC_DUPLICATE_SITE";

/**
 * Client code shape. Uppercase, digit, `_` or `-` after a leading
 * letter. Dashes are allowed because account codes on paperwork
 * commonly carry them (`VALLEY-WELLNESS`), unlike bucket codes which
 * are internal identifiers and stay strictly SCREAMING_SNAKE.
 */
export const CLINIC_CODE_REGEX = /^[A-Z][A-Z0-9_-]{1,31}$/;

const inputSchema = z
  .object({
    /** Org-unique client identifier. Cited by invoices; immutable once issued. */
    code: z
      .string()
      .trim()
      .regex(
        CLINIC_CODE_REGEX,
        "code must start with an uppercase letter, then uppercase letters, digits, `_` or `-` (2-32 chars)"
      ),
    name: z.string().trim().min(1).max(200),
    /**
     * Pharmacy sites that may fill for this client. First entry is the
     * primary. At least one — see the header.
     */
    siteIds: z.array(z.uuid()).min(1).max(50),
  })
  .strict();

export type CreateClinicInput = z.infer<typeof inputSchema>;

export interface CreateClinicOutput {
  readonly clinicId: string;
  readonly code: string;
  readonly name: string;
  readonly status: ClinicStatus;
  readonly siteIds: ReadonlyArray<string>;
}

export const CreateClinic: Command<CreateClinicInput, CreateClinicOutput> = {
  name: "CreateClinic",
  inputSchema,
  permission: PERMISSIONS.CLINICS_CREATE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<CreateClinicOutput>> {
    // A repeated site id would make "which link is primary" depend on
    // array position twice over, and the unique index on
    // (clinicId, siteId) would fail mid-write anyway. Reject it here
    // where the message can name the problem.
    const uniqueSiteIds = new Set(input.siteIds);
    if (uniqueSiteIds.size !== input.siteIds.length) {
      throw new errors.ValidationError({
        code: CREATE_CLINIC_DUPLICATE_SITE,
        message: "siteIds contains the same pharmacy site more than once.",
        metadata: { siteIdCount: input.siteIds.length, distinctCount: uniqueSiteIds.size },
      });
    }

    // Operator-supplied uuids. Each must be proven to live in the
    // actor's org before it is written, or a clinic could be pinned to
    // another tenant's site and every queue read for this client would
    // carry that site id.
    const sites = await tx.pharmacySite.findMany({
      where: { id: { in: input.siteIds }, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (sites.length !== uniqueSiteIds.size) {
      const found = new Set(sites.map((s) => s.id));
      const missing = input.siteIds.filter((id) => !found.has(id));
      throw new errors.ValidationError({
        code: CREATE_CLINIC_SITE_NOT_IN_ORG,
        message: "One or more pharmacy sites were not found in this organization.",
        metadata: { missingSiteIds: missing },
      });
    }

    let clinicId: string;
    try {
      const created = await tx.clinic.create({
        data: {
          organizationId: ctx.organizationId,
          code: input.code,
          name: input.name,
          status: ClinicStatus.ACTIVE,
          siteLinks: {
            create: input.siteIds.map((siteId, index) => ({
              siteId,
              isPrimary: index === 0,
            })),
          },
        },
        select: { id: true },
      });
      clinicId = created.id;
    } catch (cause) {
      // `@@unique([organizationId, code])`.
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        throw new errors.ConflictError({
          code: CREATE_CLINIC_CODE_ALREADY_EXISTS,
          message: `A client with code "${input.code}" already exists in this organization.`,
          metadata: { code: input.code },
          cause,
        });
      }
      throw cause;
    }

    const occurredAt = clock.now();

    return {
      output: Object.freeze({
        clinicId,
        code: input.code,
        name: input.name,
        status: ClinicStatus.ACTIVE,
        siteIds: Object.freeze([...input.siteIds]),
      }),
      audit: {
        action: "org.clinic.created",
        resourceType: "Clinic",
        resourceId: clinicId,
        metadata: {
          code: input.code,
          name: input.name,
          status: ClinicStatus.ACTIVE,
          siteIds: input.siteIds,
          primarySiteId: input.siteIds[0],
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.clinic.created.v1",
          aggregateType: "Clinic",
          aggregateId: clinicId,
          payload: {
            organizationId: ctx.organizationId,
            clinicId,
            code: input.code,
            name: input.name,
            occurredAt: occurredAt.toISOString(),
          },
        },
      ],
    };
  },
};
