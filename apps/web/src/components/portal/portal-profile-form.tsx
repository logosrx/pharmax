// Prescriber contact-details form (ADR-0033, slice 3).
//
// PATCHes /api/portal/v1/profile — which routes through the same
// UpdateProvider command operators use. Contact fields only; the
// server rejects anything else. Empty inputs submit as null
// (= clear the column), matching the command's tri-state contract.

"use client";

import { useState, type FormEvent } from "react";

const inputClass =
  "w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-fg outline-none " +
  "focus:border-brand focus:ring-2 focus:ring-ring/40";

export interface PortalProfileFormValues {
  readonly phone: string;
  readonly email: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
}

function toNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function PortalProfileForm({ initial }: { readonly initial: PortalProfileFormValues }) {
  const [values, setValues] = useState<PortalProfileFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  function set<K extends keyof PortalProfileFormValues>(key: K, value: string): void {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const response = await fetch("/api/portal/v1/profile", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          phone: toNullable(values.phone),
          email: toNullable(values.email),
          addressLine1: toNullable(values.addressLine1),
          addressLine2: toNullable(values.addressLine2),
          city: toNullable(values.city),
          state: toNullable(values.state.toUpperCase()),
          postalCode: toNullable(values.postalCode),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (response.ok) {
        setDone(true);
        setBusy(false);
        return;
      }
      setError(data.error?.message ?? "Profile update failed.");
      setBusy(false);
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full space-y-4 rounded-lg border border-line bg-surface p-6"
    >
      <h2 className="text-sm font-semibold text-fg">Contact details</h2>
      <p className="text-xs text-muted">
        Name, credential, and NPI changes go through the pharmacy — contact them directly.
      </p>

      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">Phone</span>
        <input
          type="tel"
          autoComplete="tel"
          value={values.phone}
          onChange={(e) => set("phone", e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">Office email</span>
        <input
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={(e) => set("email", e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">Address line 1</span>
        <input
          type="text"
          autoComplete="address-line1"
          value={values.addressLine1}
          onChange={(e) => set("addressLine1", e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-fg">Address line 2</span>
        <input
          type="text"
          autoComplete="address-line2"
          value={values.addressLine2}
          onChange={(e) => set("addressLine2", e.target.value)}
          className={inputClass}
        />
      </label>
      <div className="grid grid-cols-3 gap-3">
        <label className="col-span-1 block space-y-1.5">
          <span className="text-sm font-medium text-fg">City</span>
          <input
            type="text"
            autoComplete="address-level2"
            value={values.city}
            onChange={(e) => set("city", e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="col-span-1 block space-y-1.5">
          <span className="text-sm font-medium text-fg">State</span>
          <input
            type="text"
            maxLength={2}
            autoComplete="address-level1"
            value={values.state}
            onChange={(e) => set("state", e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="col-span-1 block space-y-1.5">
          <span className="text-sm font-medium text-fg">ZIP</span>
          <input
            type="text"
            autoComplete="postal-code"
            value={values.postalCode}
            onChange={(e) => set("postalCode", e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-tone-danger">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-tone-success">
          Contact details updated.
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-fg shadow-sm hover:bg-brand-hover disabled:opacity-60"
      >
        {busy ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
