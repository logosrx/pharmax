// Prescription history for one patient — the medication record a
// pharmacist reads before dispensing anything else.
//
// The patient detail page showed a single number, `orderCount`, and no
// way to see what any of those orders were for. That makes the most
// basic pharmacy question — "what is this person already on, and who
// prescribed it" — unanswerable without querying the database directly.
//
// GROUPED BY PRESCRIPTION, NOT BY ORDER. A prescription is the durable
// clinical fact; an order is one dispensing event against it. Listing
// orders would show the same drug five times for five refills and bury
// the thing a pharmacist is checking for: what is authorized, how much
// is left, and when it lapses. So each row is a prescription with its
// fills nested underneath.
//
// AUDIT: this does NOT dispatch its own `ViewPatient`. It is only ever
// called from the patient detail page, which already audits the view of
// this exact patient under `PATIENT_ADMIN_PAGE` and refuses to render
// when that write fails. A second dispatch for the same patient on the
// same page would inflate the audit trail without recording a distinct
// access. Any NEW caller must audit before calling this.
//
// PHI: returns the decrypted sig. A medication history without
// directions is not a clinical record, so it is worth the one extra
// envelope per row — bounded by the page size.

import "server-only";

import {
  readInOrgScope,
  type ControlledSubstanceSchedule,
  type OrderLineStatus,
  type OrderStatus,
  type PrescriptionStatus,
} from "@pharmax/database";
import { decryptField } from "@pharmax/crypto";

import { logger } from "../logger.js";

/** Default page size, matching the work queues. */
export const RX_HISTORY_PAGE_SIZE = 20;
export const RX_HISTORY_MAX_PAGE_SIZE = 50;

export interface RxFill {
  readonly orderId: string;
  readonly externalOrderNumber: string | null;
  readonly orderStatus: OrderStatus;
  readonly lineStatus: OrderLineStatus;
  readonly receivedAt: Date;
  readonly shippedAt: Date | null;
}

export interface PatientRxHistoryRow {
  readonly prescriptionId: string;
  readonly rxNumber: string;
  readonly drugName: string;
  readonly drugStrength: string | null;
  readonly drugForm: string | null;
  readonly drugNdc: string;
  readonly prescriberDisplayName: string;
  readonly prescriberNpi: string;
  readonly prescriberId: string;
  readonly clinicCode: string;
  /** Decrypted directions. Null if the envelope failed to decrypt. */
  readonly sig: string | null;
  readonly quantityAuthorized: string;
  readonly daysSupply: number;
  readonly refillsAuthorized: number;
  readonly refillsRemaining: number;
  readonly originalDateWritten: Date;
  readonly expiresAt: Date;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule;
  readonly status: PrescriptionStatus;
  /** Dispensing events against this prescription, newest first. */
  readonly fills: ReadonlyArray<RxFill>;
  /** True when this prescription has expired against the clock. */
  readonly expired: boolean;
}

export interface PatientRxHistory {
  readonly rows: ReadonlyArray<PatientRxHistoryRow>;
  readonly nextCursor: string | null;
  readonly totalPrescriptions: number;
  /** Sigs that could not be decrypted; drives an incident banner. */
  readonly phiDecryptErrors: number;
}

export async function getPatientRxHistory(input: {
  readonly organizationId: string;
  readonly patientId: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<PatientRxHistory> {
  const limit = Math.min(input.limit ?? RX_HISTORY_PAGE_SIZE, RX_HISTORY_MAX_PAGE_SIZE);
  const { organizationId, patientId } = input;

  // Phase 1 — all DB reads inside a short tenant transaction, so the
  // connection is released before the slow KMS work in phase 2. Same
  // shape as `getPatientDetail`.
  const { prescriptions, totalPrescriptions } = await readInOrgScope(organizationId, async (tx) => {
    const where = { organizationId, patientId };
    const [rows, total] = await Promise.all([
      tx.prescription.findMany({
        where,
        ...(input.cursor === undefined ? {} : { cursor: { id: input.cursor }, skip: 1 }),
        select: {
          id: true,
          rxNumber: true,
          drugName: true,
          drugStrength: true,
          drugForm: true,
          drugNdc: true,
          sigEnc: true,
          quantityAuthorized: true,
          daysSupply: true,
          refillsAuthorized: true,
          refillsRemaining: true,
          originalDateWritten: true,
          expiresAt: true,
          controlledSubstanceSchedule: true,
          status: true,
          clinic: { select: { code: true } },
          provider: {
            select: { id: true, npi: true, firstName: true, lastName: true, credential: true },
          },
          orderLines: {
            select: {
              lineStatus: true,
              order: {
                select: {
                  id: true,
                  externalOrderNumber: true,
                  currentStatus: true,
                  receivedAt: true,
                  shippedAt: true,
                },
              },
            },
            orderBy: { order: { receivedAt: "desc" } },
            // A prescription with more fills than this is unusual;
            // the cap keeps one outlier from dominating the page.
            take: 12,
          },
        },
        // Newest prescription first — what a pharmacist wants at the
        // top. `id` makes the sort total so the cursor is stable
        // across prescriptions written the same day.
        orderBy: [{ originalDateWritten: "desc" }, { id: "asc" }],
        take: limit + 1,
      }),
      tx.prescription.count({ where }),
    ]);
    return { prescriptions: rows, totalPrescriptions: total };
  });

  const hasMore = prescriptions.length > limit;
  const page = hasMore ? prescriptions.slice(0, limit) : prescriptions;

  // Phase 2 — decrypt the sigs outside the transaction.
  const now = new Date();
  let phiDecryptErrors = 0;

  const rows = await Promise.all(
    page.map(async (rx) => {
      let sig: string | null = null;
      try {
        sig = await decryptField({
          envelope: rx.sigEnc as Parameters<typeof decryptField>[0]["envelope"],
          binding: {
            tenantId: organizationId,
            table: "prescription",
            column: "sig",
            recordId: rx.id,
          },
        });
      } catch (cause) {
        // One unreadable sig degrades that row rather than the page.
        // Warn-level with the cause so it reaches Sentry: a decrypt
        // failure is a real incident (KMS, envelope corruption, or an
        // AAD mismatch that would mean a cross-tenant read attempt).
        phiDecryptErrors += 1;
        logger.warn("ops.patient.rx_history.sig_decrypt_failed", {
          event: "ops.patient.rx_history.sig_decrypt_failed",
          tenantId: organizationId,
          prescriptionId: rx.id,
          error: cause,
        });
      }

      const p = rx.provider;
      return Object.freeze({
        prescriptionId: rx.id,
        rxNumber: rx.rxNumber,
        drugName: rx.drugName,
        drugStrength: rx.drugStrength,
        drugForm: rx.drugForm,
        drugNdc: rx.drugNdc,
        prescriberDisplayName: `${p.firstName} ${p.lastName}${
          p.credential === null ? "" : `, ${p.credential}`
        }`,
        prescriberNpi: p.npi,
        prescriberId: p.id,
        clinicCode: rx.clinic.code,
        sig,
        // Decimal → string: the exact authorized quantity matters and a
        // float round-trip could alter it.
        quantityAuthorized: rx.quantityAuthorized.toString(),
        daysSupply: rx.daysSupply,
        refillsAuthorized: rx.refillsAuthorized,
        refillsRemaining: rx.refillsRemaining,
        originalDateWritten: rx.originalDateWritten,
        expiresAt: rx.expiresAt,
        controlledSubstanceSchedule: rx.controlledSubstanceSchedule,
        status: rx.status,
        expired: rx.expiresAt.getTime() < now.getTime(),
        fills: Object.freeze(
          rx.orderLines.map((line) =>
            Object.freeze({
              orderId: line.order.id,
              externalOrderNumber: line.order.externalOrderNumber,
              orderStatus: line.order.currentStatus,
              lineStatus: line.lineStatus,
              receivedAt: line.order.receivedAt,
              shippedAt: line.order.shippedAt,
            })
          )
        ),
      });
    })
  );

  return Object.freeze({
    rows: Object.freeze(rows),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    totalPrescriptions,
    phiDecryptErrors,
  });
}
