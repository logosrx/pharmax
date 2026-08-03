// Drug picker for the transcription screen.
//
// `list-products.ts` drives the catalog admin page and projects what a
// catalog list needs (lot counts, timestamps). Transcription needs a
// different thing: the DEA schedule for each NDC, already turned into
// the guidance the form renders, so selecting a drug can immediately
// tell the technician what the schedule permits.
//
// The catalog is the authority on the schedule — the command reads it
// back and rejects a caller who disagrees — so what is shipped here is
// a display copy, never an input the form can override.
//
// PHI: none. NDC, drug name, strength, form and schedule are catalog
// facts. Tenancy: explicit `organizationId` predicate on top of RLS.

import "server-only";

import { readInOrgScope } from "@pharmax/database";

import { scheduleGuidance, type ScheduleGuidance } from "./rx-schedule-guidance.js";

export interface TranscribableProduct {
  readonly ndc: string;
  readonly name: string;
  readonly strength: string | null;
  readonly form: string | null;
  readonly guidance: ScheduleGuidance;
}

export interface TranscribableProductsResult {
  readonly rows: ReadonlyArray<TranscribableProduct>;
  /**
   * True when the catalog holds more products than the picker shows.
   * The screen tells the operator to transcribe by NDC instead of
   * silently offering an incomplete list as if it were the whole one.
   */
  readonly truncated: boolean;
}

const PICKER_LIMIT = 200;

export async function listTranscribableProducts(input: {
  readonly organizationId: string;
}): Promise<TranscribableProductsResult> {
  const rows = await readInOrgScope(input.organizationId, (tx) =>
    tx.product.findMany({
      where: { organizationId: input.organizationId },
      select: {
        ndc: true,
        name: true,
        strength: true,
        form: true,
        controlledSubstanceSchedule: true,
      },
      orderBy: [{ name: "asc" }, { ndc: "asc" }],
      take: PICKER_LIMIT + 1,
    })
  );

  const truncated = rows.length > PICKER_LIMIT;
  const page = truncated ? rows.slice(0, PICKER_LIMIT) : rows;

  return Object.freeze({
    rows: page.map((r) =>
      Object.freeze({
        ndc: r.ndc,
        name: r.name,
        strength: r.strength,
        form: r.form,
        guidance: scheduleGuidance(r.controlledSubstanceSchedule),
      })
    ),
    truncated,
  });
}
