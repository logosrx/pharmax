"use client";

// RxTranscriptionForm — the data-entry half of the transcription
// screen.
//
// Client-side only so the controlled-substance affordances react as
// the technician picks a drug: choose a Schedule II product and the
// refills field collapses to the single lawful value before anything
// is submitted, instead of after a round trip. None of that is a rule
// this component knows. Every schedule fact it renders — the refill
// ceiling, the citation, the expiry horizon — arrives as data computed
// on the server from `@pharmax/controlled-substances`, and the command
// re-derives all of it from the product catalog when the form posts.
// The form saves the operator a round trip; it never decides anything.
//
// PHI: the sig, both notes and the indication are typed here and leave
// only in the POST body. Nothing on this screen writes them into a
// query string, and the browser is asked not to keep them.

import { useState } from "react";

import { Badge } from "../ui/badge.js";
import { Card, CardContent } from "../ui/card.js";
import { Banner } from "../ui/feedback.js";
import { Field, Input, Select, Textarea } from "../ui/field.js";
import { Section } from "../ui/page.js";
import { ActionForm, SubmitButton } from "./action-form.js";

/**
 * Server-computed schedule facts. Mirrors `ScheduleGuidance` from
 * `server/ops/rx-schedule-guidance.ts` as plain serializable data —
 * the same way `ui/workflow.ts` speaks in strings rather than
 * importing the Prisma enum into the browser bundle.
 */
export interface TranscriptionScheduleGuidance {
  readonly schedule: string;
  readonly label: string;
  readonly controlled: boolean;
  readonly maxRefills: number | null;
  readonly refillHelp: string;
  readonly refillCitation: string | null;
  readonly expiryHelp: string;
  readonly requiresPrescriberDea: boolean;
}

export interface TranscriptionProduct {
  readonly ndc: string;
  readonly name: string;
  readonly strength: string | null;
  readonly form: string | null;
  readonly guidance: TranscriptionScheduleGuidance;
}

export interface TranscriptionPrescriber {
  readonly providerId: string;
  readonly label: string;
  readonly hasDeaRegistration: boolean;
}

/** NCPDP "dispense as written" codes. */
const DAW_CODES: ReadonlyArray<{ readonly code: number; readonly label: string }> = [
  { code: 0, label: "0 — No product selection indicated" },
  { code: 1, label: "1 — Substitution not allowed by prescriber" },
  { code: 2, label: "2 — Substitution allowed, patient requested brand" },
  { code: 3, label: "3 — Substitution allowed, pharmacist selected product" },
  { code: 4, label: "4 — Substitution allowed, generic not in stock" },
  { code: 5, label: "5 — Substitution allowed, brand dispensed as generic" },
  { code: 6, label: "6 — Override" },
  { code: 7, label: "7 — Substitution not allowed, brand mandated by law" },
  { code: 8, label: "8 — Substitution allowed, generic not available" },
  { code: 9, label: "9 — Substitution allowed by prescriber, plan requests brand" },
];

const MAX_REFILLS_FIELD = 99;

export function RxTranscriptionForm({
  action,
  patientId,
  clinicId,
  today,
  prescribers,
  products,
  scheduleOptions,
  catalogTruncated,
}: {
  readonly action: string;
  readonly patientId: string;
  readonly clinicId: string;
  /** Today in UTC (YYYY-MM-DD) — the calendar the command compares against. */
  readonly today: string;
  readonly prescribers: ReadonlyArray<TranscriptionPrescriber>;
  readonly products: ReadonlyArray<TranscriptionProduct>;
  readonly scheduleOptions: ReadonlyArray<TranscriptionScheduleGuidance>;
  readonly catalogTruncated: boolean;
}) {
  const catalogAvailable = products.length > 0;
  const [fromCatalog, setFromCatalog] = useState(catalogAvailable);
  const [ndc, setNdc] = useState(products[0]?.ndc ?? "");
  const [declaredSchedule, setDeclaredSchedule] = useState(scheduleOptions[0]?.schedule ?? "");
  const [providerId, setProviderId] = useState(prescribers[0]?.providerId ?? "");
  const [refills, setRefills] = useState("0");

  const selectedProduct = products.find((p) => p.ndc === ndc);
  const guidance =
    fromCatalog && selectedProduct !== undefined
      ? selectedProduct.guidance
      : (scheduleOptions.find((s) => s.schedule === declaredSchedule) ?? scheduleOptions[0]);

  const cap = guidance?.maxRefills ?? null;
  const refillsLocked = cap === 0;
  const refillsValue = cap !== null && Number(refills) > cap ? String(cap) : refills;

  const prescriber = prescribers.find((p) => p.providerId === providerId);
  const deaMissing =
    guidance?.requiresPrescriberDea === true &&
    prescriber !== undefined &&
    !prescriber.hasDeaRegistration;

  return (
    <ActionForm action={action} className="space-y-6">
      <input type="hidden" name="patientId" value={patientId} />
      <input type="hidden" name="clinicId" value={clinicId} />

      <Card>
        <CardContent className="space-y-6">
          <Section title="Prescriber">
            <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
              <Field label="Prescriber" required>
                <Select
                  name="providerId"
                  required
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                >
                  {prescribers.map((p) => (
                    <option key={p.providerId} value={p.providerId}>
                      {p.label}
                      {p.hasDeaRegistration ? "" : " · no DEA on file"}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {deaMissing ? (
              <Banner tone="warning" title="This prescriber has no DEA registration on file">
                A controlled substance may only be prescribed by a DEA-registered practitioner (21
                CFR 1306.03), so this transcription will be refused. Read the DEA number off the
                script and have it added in Providers, or confirm who actually signed it.
              </Banner>
            ) : null}
          </Section>

          <Section
            title="Drug"
            aside={
              guidance === undefined ? null : (
                <Badge tone={guidance.controlled ? "warning" : "neutral"}>{guidance.label}</Badge>
              )
            }
          >
            <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
              <Field
                label="Source"
                help={
                  catalogTruncated
                    ? "The catalog is larger than this list. Transcribe by NDC if the drug isn't shown."
                    : undefined
                }
              >
                <Select
                  value={fromCatalog ? "catalog" : "manual"}
                  onChange={(e) => setFromCatalog(e.target.value === "catalog")}
                  disabled={!catalogAvailable}
                >
                  <option value="catalog">From the product catalog</option>
                  <option value="manual">Not in the catalog — enter the NDC</option>
                </Select>
              </Field>

              {fromCatalog ? (
                <Field label="Drug" required help="The catalog's DEA schedule governs this Rx.">
                  <Select
                    name="drugNdc"
                    required
                    value={ndc}
                    onChange={(e) => setNdc(e.target.value)}
                  >
                    {products.map((p) => (
                      <option key={p.ndc} value={p.ndc}>
                        {p.name}
                        {p.strength === null ? "" : ` ${p.strength}`} · {p.ndc}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <>
                  <Field label="NDC" required help="10 or 11 digits, as printed on the package.">
                    <Input
                      name="drugNdc"
                      required
                      maxLength={32}
                      autoComplete="off"
                      className="font-mono"
                    />
                  </Field>
                  <Field label="Drug name" required>
                    <Input name="drugName" required maxLength={200} autoComplete="off" />
                  </Field>
                  <Field label="Strength">
                    <Input name="drugStrength" maxLength={100} autoComplete="off" />
                  </Field>
                  <Field label="Dosage form">
                    <Input name="drugForm" maxLength={100} autoComplete="off" />
                  </Field>
                  <Field
                    label="DEA schedule"
                    required
                    help="Required for an uncatalogued NDC — nothing is assumed non-controlled."
                  >
                    <Select
                      name="controlledSubstanceSchedule"
                      required
                      value={declaredSchedule}
                      onChange={(e) => setDeclaredSchedule(e.target.value)}
                    >
                      {scheduleOptions.map((s) => (
                        <option key={s.schedule} value={s.schedule}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </>
              )}
            </div>

            {/* The catalog owns the schedule, so a catalogued drug
                sends its identity along without offering the operator
                a value the command would reject. */}
            {fromCatalog && selectedProduct !== undefined ? (
              <>
                <input type="hidden" name="drugName" value={selectedProduct.name} />
                {selectedProduct.strength === null ? null : (
                  <input type="hidden" name="drugStrength" value={selectedProduct.strength} />
                )}
                {selectedProduct.form === null ? null : (
                  <input type="hidden" name="drugForm" value={selectedProduct.form} />
                )}
              </>
            ) : null}
          </Section>

          <Section title="Directions and quantity">
            <Field
              label="Sig — directions for use"
              required
              help="Encrypted at rest and kept out of every log and URL."
            >
              <Textarea
                name="sig"
                required
                maxLength={2000}
                rows={2}
                autoComplete="off"
                placeholder="Take 1 tablet by mouth twice daily"
              />
            </Field>
            <div className="mt-3 grid grid-cols-1 gap-3 @3xl:grid-cols-4">
              <Field label="Quantity" required help="Up to four decimal places.">
                <Input
                  name="quantityAuthorized"
                  required
                  inputMode="decimal"
                  pattern="[0-9]{1,14}([.][0-9]{1,4})?"
                  placeholder="30"
                  autoComplete="off"
                  className="font-mono"
                />
              </Field>
              <Field label="Days supply" required>
                <Input name="daysSupply" type="number" min="1" max="365" step="1" required />
              </Field>
              <Field
                label="Refills authorized"
                required
                help={guidance?.refillHelp}
                htmlFor="refillsAuthorized"
              >
                <Input
                  id="refillsAuthorized"
                  name="refillsAuthorized"
                  type="number"
                  min="0"
                  max={String(cap ?? MAX_REFILLS_FIELD)}
                  step="1"
                  required
                  readOnly={refillsLocked}
                  aria-describedby={refillsLocked ? "refills-federal-cap" : undefined}
                  value={refillsValue}
                  onChange={(e) => setRefills(e.target.value)}
                />
              </Field>
              <Field label="DAW">
                <Select name="daw" defaultValue="0">
                  {DAW_CODES.map((d) => (
                    <option key={d.code} value={d.code}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {refillsLocked && guidance !== undefined ? (
              <p id="refills-federal-cap" className="mt-2 text-xs text-tone-warning-accent">
                {guidance.refillHelp}
                {guidance.refillCitation === null ? "" : ` (${guidance.refillCitation})`} A refill
                on this schedule needs a new prescription from the prescriber.
              </p>
            ) : null}
          </Section>

          <Section title="Dates">
            <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-3">
              <Field label="Date written" required>
                <Input
                  name="originalDateWritten"
                  type="date"
                  required
                  max={today}
                  defaultValue={today}
                />
              </Field>
              <Field label="Expires" help={guidance?.expiryHelp}>
                <Input name="expiresAt" type="date" />
              </Field>
              <Field label="Do not fill before" help="Only when the prescriber staged the fill.">
                <Input name="earliestFillDate" type="date" />
              </Field>
            </div>
          </Section>

          <Section title="Notes" aside="Optional · clinical free text">
            <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-3">
              <Field label="Note to pharmacist">
                <Textarea name="noteToPharmacist" maxLength={2000} rows={2} autoComplete="off" />
              </Field>
              <Field label="Note to patient">
                <Textarea name="noteToPatient" maxLength={2000} rows={2} autoComplete="off" />
              </Field>
              <Field label="Indication">
                <Textarea name="indication" maxLength={500} rows={2} autoComplete="off" />
              </Field>
            </div>
          </Section>

          <SubmitButton variant="go" icon="check">
            Transcribe prescription
          </SubmitButton>
        </CardContent>
      </Card>
    </ActionForm>
  );
}
