// Patient-detail projection — drives `/ops/admin/patients/[id]`.
//
// Reads the patient row (with all PHI envelopes), the joined
// clinic name, and the count of orders in the active tenant. The
// decrypted PHI block is built via `decryptPatientFields`.
//
// PHI rule: the caller MUST dispatch `ViewPatient` BEFORE
// rendering. If audit fails, do not render — that's the load-
// bearing invariant established by the order-detail slice.

import "server-only";

import { prisma, type PatientStatus } from "@pharmax/database";

import { decryptPatientFields, type DecryptedPatientFields } from "./decrypt-patient.js";

export interface PatientDetail {
  readonly patientId: string;
  readonly organizationId: string;
  readonly clinicId: string;
  readonly clinicName: string;
  readonly status: PatientStatus;
  readonly cryptoShreddedAt: Date | null;
  readonly mergedIntoPatientId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly fields: DecryptedPatientFields;
  /** True iff one or more PHI envelopes failed to decrypt. */
  readonly phiDecryptErrors: boolean;
  /** Number of orders attached to this patient in the active tenant. */
  readonly orderCount: number;
}

export async function getPatientDetail(input: {
  readonly organizationId: string;
  readonly patientId: string;
}): Promise<PatientDetail | null> {
  const patient = await prisma.patient.findFirst({
    where: { id: input.patientId, organizationId: input.organizationId },
    select: {
      id: true,
      organizationId: true,
      clinicId: true,
      status: true,
      cryptoShreddedAt: true,
      mergedIntoPatientId: true,
      createdAt: true,
      updatedAt: true,
      firstNameEnc: true,
      lastNameEnc: true,
      middleNameEnc: true,
      dateOfBirthEnc: true,
      sexAtBirthEnc: true,
      ssnLast4Enc: true,
      phoneEnc: true,
      emailEnc: true,
      addressLine1Enc: true,
      addressLine2Enc: true,
      cityEnc: true,
      stateEnc: true,
      postalCodeEnc: true,
      mrnEnc: true,
      clinic: { select: { name: true } },
    },
  });
  if (patient === null) return null;

  const decrypted = await decryptPatientFields({
    organizationId: input.organizationId,
    patientId: patient.id,
    row: patient,
  });

  const orderCount = await prisma.order.count({
    where: { organizationId: input.organizationId, patientId: patient.id },
  });

  return Object.freeze({
    patientId: patient.id,
    organizationId: patient.organizationId,
    clinicId: patient.clinicId,
    clinicName: patient.clinic.name,
    status: patient.status,
    cryptoShreddedAt: patient.cryptoShreddedAt,
    mergedIntoPatientId: patient.mergedIntoPatientId,
    createdAt: patient.createdAt,
    updatedAt: patient.updatedAt,
    fields: decrypted.fields,
    phiDecryptErrors: decrypted.phiDecryptErrors,
    orderCount,
  });
}
