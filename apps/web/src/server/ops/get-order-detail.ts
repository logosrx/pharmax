// Order detail projection — used by the `/ops/orders/[orderId]`
// page. Loads:
//
//   - Order + clinic + site (non-PHI)
//   - Patient with DECRYPTED PHI fields (name, DOB, address,
//     phone, email) — this is the operator-trusted PHI surface.
//   - Order lines (which prescription, quantity to fill, lot if
//     assigned)
//   - Recent order events (audit timeline)
//
// Decryption:
//   - Uses `@pharmax/crypto::decryptField` per encrypted column.
//   - Decryption failures (corrupt envelope, KMS misconfig) return
//     `null` for that single field rather than aborting the page —
//     a partial render with `"(decryption failed)"` is more useful
//     than a 500 when an operator is trying to triage a stuck order.
//   - The function returns BOTH plaintext AND a `phiDecryptErrors`
//     flag so the page can surface a warning banner.
//
// PHI audit:
//   - The caller (page) is responsible for emitting an audit log
//     when this projection is rendered. A future slice adds a
//     `ViewPatient` SystemCommand for tamper-evident PHI-view
//     audit; for now the page logs structured `phi.viewed` events
//     via the standard logger.
//
// Tenancy:
//   - Caller MUST have resolved a TenancyContext. The query passes
//     the explicit `organizationId` predicate as defense in depth
//     above the RLS.

import "server-only";

import { decryptField } from "@pharmax/crypto";
import {
  type PackagePhotoMatchStrategy,
  type PackagePhotoTrackingSource,
  readInOrgScope,
  type OrderPriority,
  type OrderStatus,
} from "@pharmax/database";

interface RawPhiEnvelope {
  // Envelope shape from @pharmax/crypto. We treat it as opaque
  // JSON here; decryptField does the validation.
  readonly [key: string]: unknown;
}

// Cap the matched-photo join. An order has 1 photo in the common
// case, a handful after damage re-captures; the cap guards against a
// pathological capture loop unbounding the order-detail read.
const PACKAGE_PHOTO_LIMIT = 25;

export interface OrderDetailPatient {
  readonly patientId: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly middleName: string | null;
  readonly dateOfBirth: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
}

export interface OrderDetailPrescriptionLine {
  readonly orderLineId: string;
  readonly prescriptionId: string;
  readonly rxNumber: string;
  readonly drugNdc: string;
  readonly drugName: string;
  readonly drugStrength: string | null;
  readonly drugForm: string | null;
  readonly quantityToFill: string;
  readonly daysSupplyToFill: number;
  readonly refillsRemaining: number;
  readonly sig: string | null;
  /** Provider name; non-PHI by HIPAA Safe Harbor convention. */
  readonly prescriberName: string;
  readonly prescriberNpi: string;
  readonly assignedLotNumber: string | null;
  readonly assignedLotExpiry: Date | null;
  readonly vialLabelId: string | null;
}

export interface OrderDetailEvent {
  readonly orderEventId: string;
  readonly eventType: string;
  readonly sequenceNumber: number;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
}

/**
 * A sealed-package photo matched to this order (via the
 * `PackagePhotoMatchedOrder` back-relation). Structural-only: we do
 * NOT decrypt `notesEnc` here — notes can carry incidental PHI and
 * the operator's reconciliation need is "which packages shipped for
 * this order", answered by the capture metadata. (Rendering the
 * actual image bytes needs a download/stream route that doesn't
 * exist yet; this surfaces the storage descriptor instead.)
 */
export interface OrderDetailPackagePhoto {
  readonly photoId: string;
  readonly capturedAt: Date;
  readonly capturedByUserId: string;
  readonly matchStrategy: PackagePhotoMatchStrategy;
  readonly matchedAt: Date | null;
  readonly trackingNumber: string | null;
  readonly trackingSource: PackagePhotoTrackingSource | null;
  readonly contentType: string;
  readonly fileSize: number;
  readonly sha256: string;
}

export interface OrderDetail {
  readonly orderId: string;
  readonly externalOrderNumber: string | null;
  readonly organizationId: string;
  readonly clinicId: string;
  readonly siteId: string;
  readonly currentStatus: OrderStatus;
  readonly priority: OrderPriority;
  readonly receivedAt: Date;
  readonly slaDeadlineAt: Date | null;
  readonly currentBucketId: string;
  readonly currentAssigneeUserId: string | null;
  readonly version: number;
  readonly patient: OrderDetailPatient;
  readonly lines: ReadonlyArray<OrderDetailPrescriptionLine>;
  readonly events: ReadonlyArray<OrderDetailEvent>;
  readonly packagePhotos: ReadonlyArray<OrderDetailPackagePhoto>;
  /**
   * True when ANY PHI field failed to decrypt. The page renders a
   * red banner so the operator doesn't make a clinical decision on
   * incomplete information.
   */
  readonly phiDecryptErrors: boolean;
}

async function tryDecrypt(input: {
  envelope: unknown;
  binding: { tenantId: string; table: string; column: string; recordId: string };
}): Promise<{ value: string | null; ok: boolean }> {
  if (input.envelope === null || input.envelope === undefined) {
    return { value: null, ok: true };
  }
  try {
    const plain = await decryptField({
      envelope: input.envelope as Parameters<typeof decryptField>[0]["envelope"],
      binding: input.binding,
    });
    return { value: plain, ok: true };
  } catch {
    return { value: null, ok: false };
  }
}

export async function getOrderDetail(input: {
  readonly organizationId: string;
  readonly orderId: string;
  /** Cap the event timeline; default 50 (most-recent first). */
  readonly eventLimit?: number;
}): Promise<OrderDetail | null> {
  const eventLimit = Math.min(input.eventLimit ?? 50, 200);

  // Phase 1 — load the order graph inside a short tenant tx (ORM
  // extension + RLS GUC). Released before KMS decryption below.
  const order = await readInOrgScope(input.organizationId, (tx) =>
    tx.order.findFirst({
      where: { id: input.orderId, organizationId: input.organizationId },
      select: {
        id: true,
        externalOrderNumber: true,
        organizationId: true,
        clinicId: true,
        siteId: true,
        currentStatus: true,
        priority: true,
        receivedAt: true,
        slaDeadlineAt: true,
        currentBucketId: true,
        currentAssigneeUserId: true,
        version: true,
        patient: {
          select: {
            id: true,
            firstNameEnc: true,
            lastNameEnc: true,
            middleNameEnc: true,
            dateOfBirthEnc: true,
            phoneEnc: true,
            emailEnc: true,
            addressLine1Enc: true,
            addressLine2Enc: true,
            cityEnc: true,
            stateEnc: true,
            postalCodeEnc: true,
          },
        },
        orderLines: {
          select: {
            id: true,
            quantityToFill: true,
            daysSupplyToFill: true,
            vialLabelId: true,
            lot: {
              select: { lotNumber: true, expirationDate: true },
            },
            prescription: {
              select: {
                id: true,
                rxNumber: true,
                drugNdc: true,
                drugName: true,
                drugStrength: true,
                drugForm: true,
                refillsRemaining: true,
                sigEnc: true,
                provider: {
                  select: {
                    firstName: true,
                    lastName: true,
                    credential: true,
                    npi: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        orderEvents: {
          select: {
            id: true,
            eventType: true,
            sequenceNumber: true,
            occurredAt: true,
            actorUserId: true,
          },
          orderBy: { occurredAt: "desc" },
          take: eventLimit,
        },
        // Sealed-package photos matched to this order. Structural
        // fields only — `notesEnc` is deliberately NOT selected
        // (PHI-adjacent; same guard as every other package-photo
        // surface). Newest-first; capped so a pathological
        // re-capture loop can't unbound the order page.
        packagePhotos: {
          // Archived captures are dispositioned out of the timeline
          // (test shots, dupes, fixed-misclicks) — soft-delete gate.
          where: { archivedAt: null },
          select: {
            id: true,
            capturedAt: true,
            capturedByUserId: true,
            matchStrategy: true,
            matchedAt: true,
            trackingNumber: true,
            trackingSource: true,
            contentType: true,
            fileSize: true,
            sha256: true,
          },
          orderBy: { capturedAt: "desc" },
          take: PACKAGE_PHOTO_LIMIT,
        },
      },
    })
  );

  if (order === null) return null;

  // ---- Decrypt patient PHI fields in parallel ----
  const patientId = order.patient.id;
  const decryptBinding = (column: string) =>
    ({
      tenantId: input.organizationId,
      table: "patient",
      column,
      recordId: patientId,
    }) as const;

  const [
    firstName,
    lastName,
    middleName,
    dateOfBirth,
    phone,
    email,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
  ] = await Promise.all([
    tryDecrypt({ envelope: order.patient.firstNameEnc, binding: decryptBinding("firstName") }),
    tryDecrypt({ envelope: order.patient.lastNameEnc, binding: decryptBinding("lastName") }),
    tryDecrypt({ envelope: order.patient.middleNameEnc, binding: decryptBinding("middleName") }),
    tryDecrypt({
      envelope: order.patient.dateOfBirthEnc,
      binding: decryptBinding("dateOfBirth"),
    }),
    tryDecrypt({ envelope: order.patient.phoneEnc, binding: decryptBinding("phone") }),
    tryDecrypt({ envelope: order.patient.emailEnc, binding: decryptBinding("email") }),
    tryDecrypt({
      envelope: order.patient.addressLine1Enc,
      binding: decryptBinding("addressLine1"),
    }),
    tryDecrypt({
      envelope: order.patient.addressLine2Enc,
      binding: decryptBinding("addressLine2"),
    }),
    tryDecrypt({ envelope: order.patient.cityEnc, binding: decryptBinding("city") }),
    tryDecrypt({ envelope: order.patient.stateEnc, binding: decryptBinding("state") }),
    tryDecrypt({
      envelope: order.patient.postalCodeEnc,
      binding: decryptBinding("postalCode"),
    }),
  ]);

  let phiDecryptErrors = [
    firstName,
    lastName,
    middleName,
    dateOfBirth,
    phone,
    email,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
  ].some((d) => !d.ok);

  // ---- Decrypt per-line sig (PHI) ----
  const lines: OrderDetailPrescriptionLine[] = await Promise.all(
    order.orderLines.map(async (line) => {
      const sig = await tryDecrypt({
        envelope: line.prescription.sigEnc as RawPhiEnvelope,
        binding: {
          tenantId: input.organizationId,
          table: "prescription",
          column: "sig",
          recordId: line.prescription.id,
        },
      });
      if (!sig.ok) phiDecryptErrors = true;
      const credentialSuffix =
        line.prescription.provider.credential !== null &&
        line.prescription.provider.credential.length > 0
          ? `, ${line.prescription.provider.credential}`
          : "";
      return Object.freeze({
        orderLineId: line.id,
        prescriptionId: line.prescription.id,
        rxNumber: line.prescription.rxNumber,
        drugNdc: line.prescription.drugNdc,
        drugName: line.prescription.drugName,
        drugStrength: line.prescription.drugStrength,
        drugForm: line.prescription.drugForm,
        quantityToFill: String(line.quantityToFill),
        daysSupplyToFill: line.daysSupplyToFill,
        refillsRemaining: line.prescription.refillsRemaining,
        sig: sig.value,
        prescriberName: `${line.prescription.provider.firstName} ${line.prescription.provider.lastName}${credentialSuffix}`,
        prescriberNpi: line.prescription.provider.npi,
        assignedLotNumber: line.lot?.lotNumber ?? null,
        assignedLotExpiry: line.lot?.expirationDate ?? null,
        vialLabelId: line.vialLabelId,
      });
    })
  );

  return Object.freeze({
    orderId: order.id,
    externalOrderNumber: order.externalOrderNumber,
    organizationId: order.organizationId,
    clinicId: order.clinicId,
    siteId: order.siteId,
    currentStatus: order.currentStatus,
    priority: order.priority,
    receivedAt: order.receivedAt,
    slaDeadlineAt: order.slaDeadlineAt,
    currentBucketId: order.currentBucketId,
    currentAssigneeUserId: order.currentAssigneeUserId,
    version: order.version,
    patient: Object.freeze({
      patientId,
      firstName: firstName.value,
      lastName: lastName.value,
      middleName: middleName.value,
      dateOfBirth: dateOfBirth.value,
      phone: phone.value,
      email: email.value,
      addressLine1: addressLine1.value,
      addressLine2: addressLine2.value,
      city: city.value,
      state: state.value,
      postalCode: postalCode.value,
    }),
    lines,
    events: order.orderEvents.map((e) =>
      Object.freeze({
        orderEventId: e.id,
        eventType: e.eventType,
        sequenceNumber: e.sequenceNumber,
        occurredAt: e.occurredAt,
        actorUserId: e.actorUserId,
      })
    ),
    packagePhotos: order.packagePhotos.map((p) =>
      Object.freeze({
        photoId: p.id,
        capturedAt: p.capturedAt,
        capturedByUserId: p.capturedByUserId,
        matchStrategy: p.matchStrategy,
        matchedAt: p.matchedAt,
        trackingNumber: p.trackingNumber,
        trackingSource: p.trackingSource,
        contentType: p.contentType,
        fileSize: p.fileSize,
        sha256: p.sha256,
      })
    ),
    phiDecryptErrors,
  });
}
