"use client";

// CompoundBatchFields — the inputs of the batch-creation form, with a
// live preview of the batch number and serial range the choices
// produce.
//
// The preview mirrors the server-side construction (site code, frozen
// product serial identity, batch-of-the-day, MMDDYY): the compounding
// team should see "MAIN-T30-1-081626-1 … -40" before committing 40
// serials. The batch-of-the-day counter is allocated server-side at
// save, so the preview assumes "next batch today = 1" and says so.
// Native inputs keep their `name` attributes; the surrounding
// ActionForm posts them unchanged.

import { useState } from "react";

import { Field, Input, Select } from "../ui/field.js";

export interface CompoundProductChoice {
  readonly productId: string;
  readonly name: string;
  readonly strength: string | null;
  readonly pharmaxProductId: string | null;
  readonly unitKind: string | null;
  readonly serialDrugInitial: string | null;
  readonly serialDrugMg: number | null;
}

export interface SiteChoice {
  readonly siteId: string;
  readonly code: string;
  readonly name: string;
}

const UNIT_WORDS: Readonly<Record<string, string>> = {
  VIAL: "vials",
  TABLET: "tablets",
  CAPSULE: "capsules",
  SYRINGE: "syringes",
  PEN: "pens",
  TROCHE: "troches",
  OTHER: "units",
};

function normalizeSiteCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatDateCode(isoDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [year, month, day] = isoDate.split("-");
  return `${month}${day}${year!.slice(2)}`;
}

export function CompoundBatchFields({
  products,
  sites,
  defaultCompoundedOn,
}: {
  readonly products: ReadonlyArray<CompoundProductChoice>;
  readonly sites: ReadonlyArray<SiteChoice>;
  /** Today, ISO, resolved server-side so SSR and client agree. */
  readonly defaultCompoundedOn: string;
}) {
  const [productId, setProductId] = useState(products[0]?.productId ?? "");
  const [siteId, setSiteId] = useState(sites[0]?.siteId ?? "");
  const [unitCount, setUnitCount] = useState("");
  const [compoundedOn, setCompoundedOn] = useState(defaultCompoundedOn);

  const product = products.find((p) => p.productId === productId) ?? null;
  const site = sites.find((s) => s.siteId === siteId) ?? null;

  const dateCode = formatDateCode(compoundedOn);
  const count = /^\d{1,4}$/.test(unitCount) && Number(unitCount) > 0 ? Number(unitCount) : null;
  const preview =
    product !== null &&
    product.serialDrugInitial !== null &&
    product.serialDrugMg !== null &&
    site !== null &&
    dateCode !== null
      ? `${normalizeSiteCode(site.code)}-${product.serialDrugInitial}${product.serialDrugMg}-1-${dateCode}`
      : null;

  const unitWord = UNIT_WORDS[product?.unitKind ?? "OTHER"] ?? "units";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Compound" help="Only in-house compounds can be batched">
          <Select
            name="productId"
            required
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            {products.map((p) => (
              <option key={p.productId} value={p.productId}>
                {p.name}
                {p.strength !== null ? ` ${p.strength}` : ""}
                {p.pharmaxProductId !== null ? ` — ${p.pharmaxProductId}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Pharmacy site" help="Its code prefixes every serial">
          <Select name="siteId" required value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            {sites.map((s) => (
              <option key={s.siteId} value={s.siteId}>
                {s.code} — {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={`Number of ${unitWord}`}
          help="Each gets its own serial number, minted at save"
        >
          <Input
            name="unitCount"
            type="number"
            min="1"
            max="5000"
            step="1"
            required
            className="font-mono"
            value={unitCount}
            onChange={(e) => setUnitCount(e.target.value)}
          />
        </Field>
        <Field label="Compounded on" help="The date printed in every serial (MMDDYY)">
          <Input
            name="compoundedOn"
            type="date"
            required
            className="font-mono"
            value={compoundedOn}
            onChange={(e) => setCompoundedOn(e.target.value)}
          />
        </Field>
        <Field label="Beyond-Use Date" help="USP <797> BUD — dispensing stops at this date">
          <Input name="beyondUseDate" type="date" required className="font-mono" />
        </Field>
      </div>

      <p className="text-sm text-muted">
        {preview !== null ? (
          <>
            Batch number will look like{" "}
            <span className="font-mono font-medium text-fg">{preview}</span>
            {count !== null ? (
              <>
                {" "}
                with serials <span className="font-mono font-medium text-fg">{preview}-1</span>
                {" … "}
                <span className="font-mono font-medium text-fg">
                  {preview}-{count}
                </span>
              </>
            ) : null}
            . The batch-of-the-day counter (the “1”) is assigned at save — it increments if this
            compound was already batched at this site today.
          </>
        ) : (
          <>
            Pick a compound, site, and date to preview the batch number — site code, drug initial +
            mg, batch of the day, compounding date (MMDDYY).
          </>
        )}
      </p>
    </div>
  );
}
