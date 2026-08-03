// Contract tests for POST /api/ops/prescriptions/create.
//
// `dispatchOpsCommand` owns the session, tenancy, idempotency and
// redirect machinery and is tested through the routes that already use
// it. What is specific to THIS route is the transport decoding — a
// browser form posts strings, and the command wants numbers for the
// counts and wants optional free text absent rather than empty — plus
// where the operator lands afterwards. So the suite captures the
// config the route hands the helper and exercises it directly.
//
// PHI: the sig is synthetic, must reach the command, and must appear
// in neither redirect URL.

import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchOpsCommandMock = vi.hoisted(() => vi.fn());

vi.mock("@/server/ops/dispatch-from-route", () => ({
  dispatchOpsCommand: dispatchOpsCommandMock,
}));

vi.mock("@pharmax/orders", () => ({
  CreatePrescription: { name: "CreatePrescription" },
}));

import { POST } from "./route.js";

const SYNTHETIC_SIG = "Take 1 capsule by mouth at bedtime";

const FORM_FIELDS: Readonly<Record<string, string>> = {
  patientId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0002",
  clinicId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0001",
  providerId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0003",
  drugNdc: "00093-0058-01",
  drugName: "Synthetic Test Capsule",
  quantityAuthorized: "30",
  daysSupply: "30",
  refillsAuthorized: "0",
  originalDateWritten: "2026-07-01",
  daw: "0",
  sig: SYNTHETIC_SIG,
};

const OUTPUT = {
  prescriptionId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0009",
  rxNumber: "RX-0000042",
  controlledSubstanceSchedule: "CII",
  expiresAt: "2027-01-01",
};

interface CapturedConfig {
  readonly buildInput: (input: { readonly body: FormData }) => Record<string, unknown>;
  readonly successRedirect: (output: typeof OUTPUT) => string;
  readonly failureRedirect: () => string;
  readonly idempotencyKeyPrefix: string;
}

function formBody(overrides: Readonly<Record<string, string>> = {}): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries({ ...FORM_FIELDS, ...overrides })) {
    body.set(key, value);
  }
  return body;
}

/** Run the route, then return the config it handed the dispatcher. */
async function capture(): Promise<CapturedConfig> {
  await POST(new Request("http://localhost/api/ops/prescriptions/create", { method: "POST" }));
  return dispatchOpsCommandMock.mock.calls[0]?.[0] as CapturedConfig;
}

beforeEach(() => {
  dispatchOpsCommandMock.mockReset().mockResolvedValue(new Response(null, { status: 303 }));
});

describe("POST /api/ops/prescriptions/create", () => {
  it("dispatches CreatePrescription and nothing else", async () => {
    const config = await capture();
    const [call] = dispatchOpsCommandMock.mock.calls as [[{ command: { name: string } }]];
    expect(call[0].command.name).toBe("CreatePrescription");
    expect(config.idempotencyKeyPrefix).toBe("route:create-prescription");
  });

  it("decodes the counts as numbers — the command's schema wants integers", async () => {
    const config = await capture();
    const input = config.buildInput({ body: formBody() });
    expect(input["daysSupply"]).toBe(30);
    expect(input["refillsAuthorized"]).toBe(0);
    expect(input["daw"]).toBe(0);
    // The quantity stays a string: the column is DECIMAL(18,4) and a
    // float cannot round-trip every four-decimal value.
    expect(input["quantityAuthorized"]).toBe("30");
  });

  it("omits empty optional text rather than sending a blank string", async () => {
    const config = await capture();
    const input = config.buildInput({
      body: formBody({ noteToPharmacist: "   ", indication: "", drugStrength: "" }),
    });
    expect(input["noteToPharmacist"]).toBeUndefined();
    expect(input["indication"]).toBeUndefined();
    expect(input["drugStrength"]).toBeUndefined();
  });

  it("omits the schedule when the form left it to the catalog", async () => {
    const config = await capture();
    expect(config.buildInput({ body: formBody() })["controlledSubstanceSchedule"]).toBeUndefined();
  });

  it("forwards a declared schedule for an uncatalogued NDC", async () => {
    const config = await capture();
    const input = config.buildInput({ body: formBody({ controlledSubstanceSchedule: "CIII" }) });
    expect(input["controlledSubstanceSchedule"]).toBe("CIII");
  });

  it("passes a missing required field to the command instead of rejecting it here", async () => {
    const config = await capture();
    const input = config.buildInput({ body: formBody({ sig: "" }) });
    // No `{ error }` short-circuit: the command owns requiredness, so
    // the operator gets its typed code rather than route-local prose.
    expect("error" in input).toBe(false);
    expect(input["sig"]).toBeUndefined();
  });

  it("lands back on the same patient after success, carrying no PHI", async () => {
    const config = await capture();
    config.buildInput({ body: formBody() });
    const redirect = config.successRedirect(OUTPUT);

    const url = new URL(redirect, "http://localhost");
    expect(url.pathname).toBe("/ops/prescriptions/new");
    expect(url.searchParams.get("patientId")).toBe(FORM_FIELDS["patientId"]);
    expect(url.searchParams.get("rxNumber")).toBe(OUTPUT.rxNumber);
    expect(url.searchParams.get("schedule")).toBe(OUTPUT.controlledSubstanceSchedule);
    expect(redirect).not.toContain(SYNTHETIC_SIG);
  });

  it("keeps the patient on failure so a rejection is one field to fix, not a restart", async () => {
    const config = await capture();
    config.buildInput({ body: formBody() });
    const redirect = config.failureRedirect();
    expect(redirect).toContain(`patientId=${FORM_FIELDS["patientId"]}`);
    expect(redirect).not.toContain(SYNTHETIC_SIG);
  });

  it("falls back to bare patient search when the form had no patient", async () => {
    const config = await capture();
    const body = formBody();
    body.delete("patientId");
    config.buildInput({ body });
    expect(config.failureRedirect()).toBe("/ops/prescriptions/new");
  });
});
