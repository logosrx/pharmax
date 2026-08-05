// POST /api/ops/prescriptions/create
//
// The transcription screen's submit target. Dispatches
// `CreatePrescription` — the only supported way to put a prescription
// into Pharmax — and does nothing else. Every rule the screen hints at
// (the catalog's DEA schedule wins, refills are capped at issuance,
// the prescriber needs a DEA registration for a controlled substance,
// the Rx number comes from the allocator) is enforced there.
//
// `buildInput` only DECODES the transport: a browser form posts
// strings, the command's schema wants numbers for the counts and wants
// optional text absent rather than empty. Nothing here decides whether
// a value is acceptable — an omitted required field reaches the
// command and comes back as a typed rejection, which the screen turns
// into operator wording.
//
// RBAC enforced by the command (`prescriptions.create`).
//
// PHI: `sig`, both notes and the indication arrive in the POST body.
// They are read, handed to the command, and never logged or written
// into a redirect URL. The success and failure redirects carry only
// ids, the Rx number, the schedule and an error code.

import { CreatePrescription, type CreatePrescriptionInput } from "@pharmax/orders";

import { dispatchOpsCommand } from "../../../../../src/server/ops/dispatch-from-route.js";

const TRANSCRIPTION_PAGE = "/ops/prescriptions/new";

function readText(body: FormData | Record<string, unknown>, key: string): string | undefined {
  const raw = body instanceof FormData ? body.get(key) : body[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readNumber(body: FormData | Record<string, unknown>, key: string): number | undefined {
  const raw = readText(body, key);
  return raw === undefined ? undefined : Number(raw);
}

export async function POST(request: Request): Promise<Response> {
  // Captured during `buildInput` so a rejection lands back on the same
  // patient rather than restarting the operator at patient search.
  let patientId: string | undefined;

  return await dispatchOpsCommand({
    request,
    command: CreatePrescription,
    idempotencyKeyPrefix: "route:create-prescription",
    buildInput: ({ body }) => {
      patientId = readText(body, "patientId");
      // Cast rather than prove: a missing required field must travel
      // to the bus and come back as a typed rejection the screen can
      // explain, not be intercepted and re-described here.
      return {
        clinicId: readText(body, "clinicId"),
        patientId,
        providerId: readText(body, "providerId"),
        drugNdc: readText(body, "drugNdc"),
        drugName: readText(body, "drugName"),
        drugStrength: readText(body, "drugStrength"),
        drugForm: readText(body, "drugForm"),
        // Absent whenever the operator picked a catalogued drug: the
        // catalog is the authority on the schedule, and the command
        // rejects a caller-supplied value that disagrees with it.
        controlledSubstanceSchedule: readText(body, "controlledSubstanceSchedule"),
        quantityAuthorized: readText(body, "quantityAuthorized"),
        daysSupply: readNumber(body, "daysSupply"),
        refillsAuthorized: readNumber(body, "refillsAuthorized"),
        originalDateWritten: readText(body, "originalDateWritten"),
        expiresAt: readText(body, "expiresAt"),
        earliestFillDate: readText(body, "earliestFillDate"),
        daw: readNumber(body, "daw"),
        sig: readText(body, "sig"),
        // Structured sig — coded values, optional; an empty select or
        // input is "not captured", which `readText` renders as absent.
        // The decimals stay STRINGS: the command's schema wants exact
        // decimal strings, same as quantityAuthorized.
        sigStructureKind: readText(body, "sigStructureKind"),
        doseAmount: readText(body, "doseAmount"),
        doseUnit: readText(body, "doseUnit"),
        dosesPerDay: readText(body, "dosesPerDay"),
        noteToPharmacist: readText(body, "noteToPharmacist"),
        noteToPatient: readText(body, "noteToPatient"),
        indication: readText(body, "indication"),
      } as unknown as CreatePrescriptionInput;
    },
    successRedirect: (output) =>
      `${TRANSCRIPTION_PAGE}?${new URLSearchParams({
        ...(patientId === undefined ? {} : { patientId }),
        rxNumber: output.rxNumber,
        prescriptionId: output.prescriptionId,
        schedule: output.controlledSubstanceSchedule,
        expiresAt: output.expiresAt,
      }).toString()}`,
    failureRedirect: () =>
      patientId === undefined
        ? TRANSCRIPTION_PAGE
        : `${TRANSCRIPTION_PAGE}?patientId=${encodeURIComponent(patientId)}`,
    successLogEvent: "ops.prescriptions.create.applied",
    failureLogEvent: "ops.prescriptions.create.failed",
  });
}
