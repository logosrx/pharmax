import { decryptField } from "@pharmax/crypto";
import type { PrismaTxClient } from "@pharmax/command-bus";
import { buildVialBarcodeValue, type VialLabelRenderInput } from "@pharmax/labels";
import { errors } from "@pharmax/platform-core";

export const VIAL_LABEL_CONTEXT_NOT_FOUND = "VIAL_LABEL_CONTEXT_NOT_FOUND";
export const VIAL_LABEL_LOT_NOT_ASSIGNED = "VIAL_LABEL_LOT_NOT_ASSIGNED";

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
    },
  });

  if (line === null) {
    throw new errors.NotFoundError({
      code: VIAL_LABEL_CONTEXT_NOT_FOUND,
      message: "Order line not found for vial label rendering.",
      metadata: { orderId: input.orderId, orderLineId: input.orderLineId },
    });
  }

  if (line.lotId === null || line.lot === null) {
    throw new errors.ConflictError({
      code: VIAL_LABEL_LOT_NOT_ASSIGNED,
      message: "Assign a lot before printing the vial label.",
      metadata: { orderLineId: input.orderLineId },
    });
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
    lotNumber: line.lot.lotNumber,
    lotExpiration: line.lot.expirationDate.toISOString().slice(0, 10),
    barcodeValue: buildVialBarcodeValue(line.id),
  };
}
