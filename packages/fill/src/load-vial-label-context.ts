import { decryptField } from "@pharmax/crypto";
import type { PrismaTxClient } from "@pharmax/command-bus";
import { CompoundingQualityOutcome } from "@pharmax/database";
import { buildVialBarcodeValue, type VialLabelRenderInput } from "@pharmax/labels";
import { errors } from "@pharmax/platform-core";

export const VIAL_LABEL_CONTEXT_NOT_FOUND = "VIAL_LABEL_CONTEXT_NOT_FOUND";
export const VIAL_LABEL_LOT_NOT_ASSIGNED = "VIAL_LABEL_LOT_NOT_ASSIGNED";
// ADR-0035 slice 4: printing is blocked while the line's latest
// compounding record is a quality FAIL — a failed prep must not get
// a dispensing label.
export const VIAL_LABEL_COMPOUND_QUALITY_FAILED = "VIAL_LABEL_COMPOUND_QUALITY_FAILED";

export async function loadVialLabelRenderContext(input: {
  readonly tx: PrismaTxClient;
  readonly organizationId: string;
  readonly orderId: string;
  readonly orderLineId: string;
}): Promise<VialLabelRenderInput> {
  const line = await input.tx.orderLine.findFirst({
    where: {
      id: input.orderLineId,
      orderId: input.orderId,
      organizationId: input.organizationId,
    },
    select: {
      id: true,
      quantityToFill: true,
      daysSupplyToFill: true,
      lotId: true,
      prescription: {
        select: {
          id: true,
          rxNumber: true,
          drugNdc: true,
          drugName: true,
          drugStrength: true,
          sigEnc: true,
        },
      },
      order: {
        select: {
          patientId: true,
          patient: {
            select: {
              id: true,
              firstNameEnc: true,
              lastNameEnc: true,
            },
          },
        },
      },
      lot: {
        select: {
          lotNumber: true,
          expirationDate: true,
        },
      },
      // Compound-prep fallback (ADR-0035 slice 4): when no lot is
      // assigned, the latest compounding record anchors the label —
      // its id renders as the lot field and the BUD as the
      // expiration, per USP <795>/<797> labeling.
      compoundingRecords: {
        orderBy: { preparedAt: "desc" },
        take: 1,
        select: { id: true, qualityOutcome: true, budAt: true },
      },
    },
  });

  if (line === null) {
    throw new errors.NotFoundError({
      code: VIAL_LABEL_CONTEXT_NOT_FOUND,
      message: "Order line not found for vial label rendering.",
      metadata: { orderId: input.orderId, orderLineId: input.orderLineId },
    });
  }

  // Resolve the label's lot/expiration fields: assigned inventory
  // lot for stock lines, latest PASS compounding record (CR id +
  // BUD) for patient-specific preps without a finished-goods lot.
  let lotNumber: string;
  let lotExpiration: string;
  if (line.lotId !== null && line.lot !== null) {
    lotNumber = line.lot.lotNumber;
    lotExpiration = line.lot.expirationDate.toISOString().slice(0, 10);
  } else {
    const latestRecord = line.compoundingRecords[0];
    if (latestRecord === undefined) {
      throw new errors.ConflictError({
        code: VIAL_LABEL_LOT_NOT_ASSIGNED,
        message:
          "Assign a lot — or record the compounding preparation — before printing the vial label.",
        metadata: { orderLineId: input.orderLineId },
      });
    }
    if (latestRecord.qualityOutcome !== CompoundingQualityOutcome.PASS) {
      throw new errors.ConflictError({
        code: VIAL_LABEL_COMPOUND_QUALITY_FAILED,
        message:
          "The latest compounding record for this line is a quality FAIL. Re-prepare before printing the vial label.",
        metadata: { orderLineId: input.orderLineId, compoundingRecordId: latestRecord.id },
      });
    }
    lotNumber = `CR-${latestRecord.id.slice(0, 8).toUpperCase()}`;
    lotExpiration = latestRecord.budAt.toISOString().slice(0, 10);
  }

  const patientId = line.order.patient.id;
  const tenantId = input.organizationId;

  const [firstName, lastName, sigText] = await Promise.all([
    decryptField({
      envelope: line.order.patient.firstNameEnc,
      binding: { tenantId, table: "patient", column: "firstName", recordId: patientId },
    }),
    decryptField({
      envelope: line.order.patient.lastNameEnc,
      binding: { tenantId, table: "patient", column: "lastName", recordId: patientId },
    }),
    decryptField({
      envelope: line.prescription.sigEnc,
      binding: {
        tenantId,
        table: "prescription",
        column: "sig",
        recordId: line.prescription.id,
      },
    }),
  ]);

  return {
    patientDisplayName: `${firstName} ${lastName}`.trim(),
    drugName: line.prescription.drugName,
    drugStrength: line.prescription.drugStrength,
    drugNdc: line.prescription.drugNdc,
    rxNumber: line.prescription.rxNumber,
    quantity: line.quantityToFill.toString(),
    daysSupply: line.daysSupplyToFill,
    sigText,
    lotNumber,
    lotExpiration,
    barcodeValue: buildVialBarcodeValue(line.id),
  };
}
