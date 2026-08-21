// UpdateClinic — correct a client practice's display name.
//
// Deliberately narrow. `code` is immutable once issued: invoices,
// prescriptions and orders all cite it, and a customer holds paperwork
// that quotes it. Renaming it would retroactively change the meaning of
// records already sent, so there is no input for it and no command that
// changes it. A client whose code is genuinely wrong is a new client
// plus a deactivation, which leaves both facts on the record.
//
// `status` is not here either — it belongs to `SetClinicStatus`, which
// has a side effect (revoking portal sessions) that a name edit must
// not carry.
//
// Site links are not here. Adding or removing which sites may fill for
// a client changes operational routing rather than directory metadata,
// and it needs its own command with its own guard (a site cannot be
// unlinked while it holds in-flight orders for that client). Out of
// scope for this slice, and better absent than half-done.
//
// PHI: none.

import type { Command, HandlerResult } from "@pharmax/command-bus";
import { ClinicStatus } from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { PERMISSIONS } from "@pharmax/rbac";
import { z } from "zod";

export const UPDATE_CLINIC_NOT_FOUND = "UPDATE_CLINIC_NOT_FOUND";
export const UPDATE_CLINIC_ARCHIVED = "UPDATE_CLINIC_ARCHIVED";

const inputSchema = z
  .object({
    clinicId: z.uuid(),
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export type UpdateClinicInput = z.infer<typeof inputSchema>;

export interface UpdateClinicOutput {
  readonly clinicId: string;
  readonly code: string;
  readonly name: string;
}

export const UpdateClinic: Command<UpdateClinicInput, UpdateClinicOutput> = {
  name: "UpdateClinic",
  inputSchema,
  permission: PERMISSIONS.CLINICS_UPDATE,
  redactFields: [],

  async handle({
    input,
    ctx,
    tx,
    clock,
    commandLogId,
  }): Promise<HandlerResult<UpdateClinicOutput>> {
    const clinic = await tx.clinic.findFirst({
      where: { id: input.clinicId, organizationId: ctx.organizationId },
      select: { id: true, code: true, name: true, status: true },
    });
    if (clinic === null) {
      throw new errors.NotFoundError({
        code: UPDATE_CLINIC_NOT_FOUND,
        message: "Client not found in this organization.",
        metadata: { clinicId: input.clinicId },
      });
    }

    // ARCHIVED is terminal. Editing an archived client's name would
    // change how historical invoices render for a relationship that has
    // ended — the row is kept to explain the past, not to be revised.
    if (clinic.status === ClinicStatus.ARCHIVED) {
      throw new errors.ValidationError({
        code: UPDATE_CLINIC_ARCHIVED,
        message:
          "This client is archived and cannot be edited. Archived clients are retained to explain historical records.",
        metadata: { clinicId: input.clinicId, status: clinic.status },
      });
    }

    await tx.clinic.update({
      where: { id: clinic.id },
      data: { name: input.name },
    });

    const occurredAt = clock.now();

    return {
      output: Object.freeze({
        clinicId: clinic.id,
        code: clinic.code,
        name: input.name,
      }),
      audit: {
        action: "org.clinic.updated",
        resourceType: "Clinic",
        resourceId: clinic.id,
        metadata: {
          code: clinic.code,
          previousName: clinic.name,
          name: input.name,
          commandLogId,
        },
      },
      outboxEvents: [
        {
          eventType: "org.clinic.updated.v1",
          aggregateType: "Clinic",
          aggregateId: clinic.id,
          payload: {
            organizationId: ctx.organizationId,
            clinicId: clinic.id,
            code: clinic.code,
            name: input.name,
            occurredAt: occurredAt.toISOString(),
          },
        },
      ],
    };
  },
};
