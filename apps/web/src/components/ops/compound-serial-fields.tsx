"use client";

// CompoundSerialFields — the serial-identity inputs of the compound
// creation form, with a live preview of the batch unit number the
// choice produces.
//
// The initial + mg pair is FROZEN at creation (changing it later
// would orphan every already-printed batch label), so the admin
// should see exactly what will print — e.g. PHX-T30-1-040327-11 —
// before committing. The preview is illustrative (sample site code,
// today's date, batch 1, unit 11); the real serial is generated
// server-side at batch creation. Native inputs keep their `name`
// attributes, so the surrounding ActionForm posts them unchanged.

import { useState } from "react";

import { Field, Input } from "../ui/field.js";

function previewSerial(siteCode: string, initial: string, mg: string): string | null {
  const letter = /^[A-Za-z]$/.test(initial) ? initial.toUpperCase() : null;
  const mgNumber = /^\d{1,7}$/.test(mg) && Number(mg) > 0 ? Number(mg) : null;
  if (letter === null || mgNumber === null) return null;

  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  return `${siteCode}-${letter}${mgNumber}-1-${mm}${dd}${yy}-11`;
}

export function CompoundSerialFields({
  sampleSiteCode,
}: {
  /** A real site code from this org ("PHX") so the preview reads true. */
  readonly sampleSiteCode: string;
}) {
  const [initial, setInitial] = useState("");
  const [mg, setMg] = useState("");

  const preview = previewSerial(sampleSiteCode, initial, mg);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Primary drug initial"
          help="First letter of the primary drug — the T in T30. Frozen after creation."
        >
          <Input
            name="serialDrugInitial"
            required
            maxLength={1}
            pattern="[A-Za-z]"
            autoComplete="off"
            className="font-mono uppercase"
            value={initial}
            onChange={(e) => setInitial(e.target.value)}
          />
        </Field>
        <Field
          label="Primary drug mg per container"
          help="Total mg of the primary drug in one unit (concentration × volume) — the 30 in T30. Frozen after creation."
        >
          <Input
            name="serialDrugMg"
            type="number"
            min="1"
            step="1"
            required
            className="font-mono"
            value={mg}
            onChange={(e) => setMg(e.target.value)}
          />
        </Field>
      </div>

      <p className="text-sm text-muted">
        Batch unit numbers will look like{" "}
        {preview !== null ? (
          <span className="font-mono font-medium text-fg">{preview}</span>
        ) : (
          <span className="font-mono">{sampleSiteCode}-T30-1-040327-11</span>
        )}{" "}
        — site code, drug initial + mg, batch of the day, compounding date (MMDDYY), unit number.
      </p>
    </div>
  );
}
