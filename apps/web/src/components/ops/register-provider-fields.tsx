"use client";

// The register-a-prescriber form's NPI lookup.
//
// Typing ten digits and pressing Look up fills in name, credential and
// practice address from the CMS NPPES registry. That saves transcription
// and, more importantly, makes the recorded name match the registry the
// prescription will be checked against.
//
// EVERY FIELD STAYS EDITABLE after a lookup. NPPES is frequently stale
// on address and occasionally on credential, so the registry is treated
// as a strong suggestion, not as truth. Locking the fields would force
// an operator with better information to abandon the form.
//
// A deactivated NPI ("D") is surfaced prominently but NOT blocked here:
// the command decides, and a pharmacy onboarding a prescriber whose
// registration is mid-renewal is a real case.
//
// The DEA field is deliberately part of this form. Onboarding usually
// has the number to hand, and `RegisterProvider` records it as a
// registration covering every controlled schedule with no expiry —
// the same authority the old column conferred. The form says so,
// because an operator who wants per-schedule limits or an expiry needs
// to know to use the credentials page instead.

import { useState } from "react";

import { Field, Input, Select } from "../ui/field.js";
import { Button } from "../ui/button.js";
import { Banner } from "../ui/feedback.js";
import { Badge } from "../ui/badge.js";

/** Mirrors the JSON shape of `GET /api/ops/admin/providers/npi-lookup`. */
interface NpiLookupHit {
  readonly found: true;
  readonly npi: string;
  readonly enumerationType: string | null;
  readonly status: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly credential: string | null;
  readonly practiceAddress: {
    readonly addressLine1: string | null;
    readonly addressLine2: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
    readonly phone: string | null;
  } | null;
}

type LookupState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "found"; readonly hit: NpiLookupHit }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly message: string };

/** ZIP+4 arrives from NPPES as nine digits; the command wants a dash. */
function normalizePostalCode(raw: string | null): string {
  if (raw === null) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return digits.slice(0, 5);
}

/** NPPES returns 10 digits; the command wants 7–40 chars of free text. */
function normalizePhone(raw: string | null): string {
  if (raw === null) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 10) return raw.slice(0, 40);
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function RegisterProviderFields({
  stateCodes,
}: {
  readonly stateCodes: ReadonlyArray<string>;
}) {
  const [npi, setNpi] = useState("");
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });

  // Controlled so a lookup can write into them; the operator can still
  // type over anything afterwards.
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [credential, setCredential] = useState("");
  const [phone, setPhone] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");

  const npiComplete = /^\d{10}$/.test(npi);

  async function runLookup(): Promise<void> {
    if (!npiComplete) return;
    setLookup({ kind: "loading" });
    try {
      const response = await fetch(
        `/api/ops/admin/providers/npi-lookup?npi=${encodeURIComponent(npi)}`,
        { headers: { accept: "application/json" } }
      );
      const payload = (await response.json()) as
        NpiLookupHit | { readonly found: false } | { readonly error: string };

      if (!response.ok) {
        const message =
          "error" in payload && typeof payload.error === "string"
            ? payload.error
            : "The lookup failed. Enter the prescriber's details manually.";
        setLookup({ kind: "failed", message });
        return;
      }
      if (!("found" in payload) || payload.found !== true) {
        setLookup({ kind: "absent" });
        return;
      }

      // Only overwrite what the registry actually returned, so a
      // second lookup cannot blank a field the operator has corrected.
      const hit = payload;
      if (hit.firstName !== null) setFirstName(hit.firstName);
      if (hit.lastName !== null) setLastName(hit.lastName);
      if (hit.credential !== null) setCredential(hit.credential);
      const addr = hit.practiceAddress;
      if (addr !== null) {
        if (addr.addressLine1 !== null) setAddressLine1(addr.addressLine1);
        if (addr.addressLine2 !== null) setAddressLine2(addr.addressLine2);
        if (addr.city !== null) setCity(addr.city);
        if (addr.state !== null) setState(addr.state);
        if (addr.postalCode !== null) setPostalCode(normalizePostalCode(addr.postalCode));
        if (addr.phone !== null) setPhone(normalizePhone(addr.phone));
      }
      setLookup({ kind: "found", hit });
    } catch {
      setLookup({
        kind: "failed",
        message:
          "The lookup could not be sent. Check the connection, or enter the prescriber's details manually.",
      });
    }
  }

  const deactivated = lookup.kind === "found" && lookup.hit.status === "D";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="NPI"
          required
          help="Ten digits. Look up to fill in the rest from the CMS registry."
        >
          <Input
            name="npi"
            required
            inputMode="numeric"
            maxLength={10}
            value={npi}
            onChange={(e) => {
              setNpi(e.target.value.replace(/\D/g, "").slice(0, 10));
              setLookup({ kind: "idle" });
            }}
            className="w-40 font-mono"
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          icon="search"
          disabled={!npiComplete || lookup.kind === "loading"}
          onClick={() => {
            void runLookup();
          }}
        >
          {lookup.kind === "loading" ? "Looking up…" : "Look up"}
        </Button>
        {lookup.kind === "found" ? (
          <Badge tone={deactivated ? "danger" : "success"}>
            {deactivated ? "Registry: deactivated" : "Registry: active"}
          </Badge>
        ) : null}
      </div>

      {lookup.kind === "absent" ? (
        <Banner tone="warning" title="No such NPI in the registry">
          The registry has no record of {npi}. Check the digits. You can still register the
          prescriber manually if you are confident the number is right.
        </Banner>
      ) : null}
      {lookup.kind === "failed" ? (
        <Banner tone="warning" title="Lookup unavailable">
          {lookup.message}
        </Banner>
      ) : null}
      {deactivated ? (
        <Banner tone="danger" title="This NPI is deactivated in the registry">
          CMS lists this registration as deactivated. Registering is still permitted — a renewal in
          progress looks like this — but confirm before letting prescriptions through.
        </Banner>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="First name" required>
          <Input
            name="firstName"
            required
            maxLength={100}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
        </Field>
        <Field label="Last name" required>
          <Input
            name="lastName"
            required
            maxLength={100}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </Field>
        <Field label="Credential" help="MD, DO, NP, PA, PharmD…">
          <Input
            name="credential"
            maxLength={40}
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="DEA number"
          help="Optional. Recorded as covering every controlled schedule with no expiry — use the prescriber's credentials page for per-schedule limits or an expiry date."
        >
          <Input name="deaNumber" maxLength={9} placeholder="AB1234563" className="font-mono" />
        </Field>
        <Field label="Phone">
          <Input
            name="phone"
            maxLength={40}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Address line 1" className="sm:col-span-2">
          <Input
            name="addressLine1"
            maxLength={200}
            value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)}
          />
        </Field>
        <Field label="Address line 2" className="sm:col-span-2">
          <Input
            name="addressLine2"
            maxLength={200}
            value={addressLine2}
            onChange={(e) => setAddressLine2(e.target.value)}
          />
        </Field>
        <Field label="City">
          <Input
            name="city"
            maxLength={100}
            value={city}
            onChange={(e) => setCity(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <Select name="state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">—</option>
              {stateCodes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="ZIP">
            <Input
              name="postalCode"
              maxLength={10}
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
