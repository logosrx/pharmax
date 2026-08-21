// Turn a bare queue row into one an operator can act on without
// opening it: which client it came from, who prescribed it, whose
// prescription it is, and what drugs are on it.
//
// One helper for every queue (typing, PV1, fill, final, shipping,
// emergency) because they all render the same card. Three separate
// implementations of the join-plus-decrypt-plus-audit sequence would be
// three places for the audit step to be forgotten.
//
// COST, AND WHY THE SHAPE IS WHAT IT IS
//
// Clinic, prescriber and drug names are plaintext columns under tenant
// RLS: one extra join, no crypto, no audit obligation. The patient name
// is the opposite — two KMS unwraps and one `ViewPatient` audit
// dispatch per row — and it is the reason this file exists rather than
// four inline `select` additions.
//
// Three things keep that affordable. `decryptPatientName` unwraps two
// envelopes rather than the fourteen a detail page needs. The audit
// dispatch is idempotency-keyed by minute upstream, so a queue held
// open and refreshed writes one row per patient per minute rather than
// one per render. And the callers are paginated, so the per-render cost
// is bounded by page size instead of by queue depth.
//
// WITHHOLDING: THE ROW STAYS, THE NAME GOES
//
// This is the one place where queue behaviour deliberately differs from
// the patient search page. There, a row IS a patient, so a failed audit
// withholds the whole row — showing it would be the unaudited
// disclosure. Here a row is a unit of pharmacy work, and dropping it
// would hide a prescription from the people responsible for dispensing
// it. Hiding work is a safety problem; hiding a name is an
// inconvenience. So a failed audit masks the name and keeps the row,
// and the caller reports the count so the gap is visible rather than
// silent.
//
// PHI: returns decrypted patient names. Callers must render them as
// text only — no data attributes, no props that reach a client bundle.

import "server-only";

import { readInOrgScope, type TenantTransactionClient } from "@pharmax/database";

import { auditPatientViewsBatch } from "./audit-patient-view.js";
import { decryptPatientName } from "./decrypt-patient.js";

export interface QueuePrescriber {
  readonly displayName: string;
  readonly npi: string;
}

export interface QueueMedication {
  readonly drugName: string;
  readonly drugStrength: string | null;
  readonly drugForm: string | null;
  /** Drives the controlled-substance marker on the card. */
  readonly isControlled: boolean;
}

export interface QueueRowDetails {
  readonly clinicCode: string;
  readonly clinicName: string;
  /**
   * Usually exactly one. An order can carry lines from more than one
   * prescription, and nothing guarantees one prescriber wrote all of
   * them, so this is a list — a card that showed only the first would
   * misattribute the rest.
   */
  readonly prescribers: ReadonlyArray<QueuePrescriber>;
  readonly medications: ReadonlyArray<QueueMedication>;
  /**
   * `null` when the name could not be shown: the audit write failed, an
   * envelope failed to decrypt, or the patient has been crypto-shredded.
   * The card renders a placeholder rather than an empty gap.
   */
  readonly patientName: string | null;
  /** True only for the audit-failure case, which is not the same as undecryptable. */
  readonly patientNameWithheld: boolean;
}

export interface AttachQueueRowDetailsResult<T> {
  readonly rows: ReadonlyArray<T & QueueRowDetails>;
  /** Rows whose name was withheld because the audit write failed. */
  readonly patientNamesWithheld: number;
  /** Rows whose name was unavailable because an envelope failed to decrypt. */
  readonly phiDecryptErrors: number;
}

/** Placeholder used when an order's clinic row is somehow missing. */
const UNKNOWN_CLINIC = "—";

export async function attachQueueRowDetails<T extends { readonly orderId: string }>(input: {
  readonly organizationId: string;
  readonly operatorUserId: string;
  readonly rows: ReadonlyArray<T>;
  /** Share an outer `readInOrgScope` transaction when the page has one. */
  readonly tx?: TenantTransactionClient;
}): Promise<AttachQueueRowDetailsResult<T>> {
  if (input.rows.length === 0) {
    return Object.freeze({ rows: [], patientNamesWithheld: 0, phiDecryptErrors: 0 });
  }

  const orderIds = input.rows.map((r) => r.orderId);

  const load = async (tx: TenantTransactionClient) =>
    tx.order.findMany({
      where: { organizationId: input.organizationId, id: { in: orderIds } },
      select: {
        id: true,
        patientId: true,
        clinic: { select: { code: true, name: true } },
        patient: {
          // Only the two name envelopes. See `decryptPatientName`.
          select: { firstNameEnc: true, lastNameEnc: true, cryptoShreddedAt: true },
        },
        orderLines: {
          select: {
            prescription: {
              select: {
                drugName: true,
                drugStrength: true,
                drugForm: true,
                controlledSubstanceSchedule: true,
                provider: {
                  select: { npi: true, firstName: true, lastName: true, credential: true },
                },
              },
            },
          },
        },
      },
    });

  const orders =
    input.tx !== undefined
      ? await load(input.tx)
      : await readInOrgScope(input.organizationId, load);

  const byOrderId = new Map(orders.map((o) => [o.id, o]));

  // Decrypt once per DISTINCT patient, not once per row. Several orders
  // for one patient in the same queue is normal, and each duplicate
  // would otherwise cost two more KMS calls for a name already in hand.
  const distinctPatients = new Map<string, { firstNameEnc: unknown; lastNameEnc: unknown }>();
  for (const order of orders) {
    if (order.patient === null || order.patient.cryptoShreddedAt !== null) continue;
    if (!distinctPatients.has(order.patientId)) {
      distinctPatients.set(order.patientId, {
        firstNameEnc: order.patient.firstNameEnc,
        lastNameEnc: order.patient.lastNameEnc,
      });
    }
  }

  const decrypted = new Map<string, { name: string | null; decryptFailed: boolean }>();
  await Promise.all(
    [...distinctPatients.entries()].map(async ([patientId, row]) => {
      const result = await decryptPatientName({
        organizationId: input.organizationId,
        patientId,
        row,
      });
      const parts = [result.firstName, result.lastName].filter((p) => p !== null);
      decrypted.set(patientId, {
        name: parts.length === 0 ? null : parts.join(" "),
        decryptFailed: result.phiDecryptErrors,
      });
    })
  );

  // Audit once per distinct patient too. The command is idempotent per
  // (patient, minute), so a duplicate dispatch would collapse anyway —
  // but not issuing it saves the round trip.
  const auditBatch = await auditPatientViewsBatch({
    organizationId: input.organizationId,
    operatorUserId: input.operatorUserId,
    surface: "WORK_QUEUE",
    patients: [...distinctPatients.keys()].map((patientId) => ({
      patientId,
      phiDecryptErrors: decrypted.get(patientId)?.decryptFailed ?? false,
    })),
  });
  const auditFailed = new Set(auditBatch.failedPatientIds);

  let patientNamesWithheld = 0;
  let phiDecryptErrors = 0;

  const rows = input.rows.map((row) => {
    const order = byOrderId.get(row.orderId);
    if (order === undefined) {
      // The order left the queue between the two reads. Keep the row so
      // the operator still sees the work; it will be gone next render.
      return Object.freeze({
        ...row,
        clinicCode: UNKNOWN_CLINIC,
        clinicName: UNKNOWN_CLINIC,
        prescribers: Object.freeze([]),
        medications: Object.freeze([]),
        patientName: null,
        patientNameWithheld: false,
      });
    }

    const withheld = auditFailed.has(order.patientId);
    if (withheld) patientNamesWithheld += 1;
    const decryptedName = decrypted.get(order.patientId);
    if (decryptedName?.decryptFailed === true) phiDecryptErrors += 1;

    const prescribers = new Map<string, QueuePrescriber>();
    const medications: QueueMedication[] = [];
    for (const line of order.orderLines) {
      const rx = line.prescription;
      const p = rx.provider;
      if (!prescribers.has(p.npi)) {
        prescribers.set(p.npi, {
          displayName: `${p.firstName} ${p.lastName}${p.credential === null ? "" : `, ${p.credential}`}`,
          npi: p.npi,
        });
      }
      medications.push(
        Object.freeze({
          drugName: rx.drugName,
          drugStrength: rx.drugStrength,
          drugForm: rx.drugForm,
          isControlled: rx.controlledSubstanceSchedule !== "NON_CONTROLLED",
        })
      );
    }

    return Object.freeze({
      ...row,
      clinicCode: order.clinic.code,
      clinicName: order.clinic.name,
      prescribers: Object.freeze([...prescribers.values()]),
      medications: Object.freeze(medications),
      patientName: withheld ? null : (decryptedName?.name ?? null),
      patientNameWithheld: withheld,
    });
  });

  return Object.freeze({ rows: Object.freeze(rows), patientNamesWithheld, phiDecryptErrors });
}
