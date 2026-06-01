// Lot expiry warnings — active inventory lots that are already
// expired or will expire within a configurable horizon, sorted
// most-urgent-first.
//
// What operators use this for:
//
//   - "What's expiring in the next 30 days that I need to use or
//     pull?"
//   - "Do I have any expired lots still flagged ACTIVE/ON_HOLD
//     that should be depleted?"
//
// Unlike the date-range reports, this one takes a `withinDays`
// horizon (number field) and computes a window of
// [asOf, asOf + withinDays]. Already-expired ACTIVE/ON_HOLD lots
// are ALWAYS included (negative daysUntilExpiry) — they're the
// most urgent and excluding them would hide the worst cases.
//
// DEPLETED lots are excluded (no inventory remains to worry about).
//
// PHI invariant: lots + products are non-PHI (product name, NDC,
// lot number, expiration). No patient linkage.

import { LotStatus } from "@pharmax/database";
import { z } from "zod";

import type { ReportDefinition, ReportResult } from "../types.js";

export interface LotExpiryWarningRow {
  readonly siteId: string;
  readonly productId: string;
  readonly productName: string;
  readonly lotNumber: string;
  readonly expirationDate: string; // YYYY-MM-DD
  readonly status: LotStatus;
  readonly daysUntilExpiry: number; // negative when already expired
}

const DAY_MS = 24 * 60 * 60 * 1000;

const paramsSchema = z
  .object({
    /** Expiry horizon in days from "now". Lots expiring on or
     *  before (asOf + withinDays) are surfaced, plus any already
     *  expired. */
    withinDays: z.number().int().min(1).max(3650).default(90),
  })
  .strict();

export type LotExpiryWarningsParams = z.infer<typeof paramsSchema>;

export const lotExpiryWarningsReport: ReportDefinition<typeof paramsSchema, LotExpiryWarningRow> = {
  id: "lot-expiry-warnings",
  version: 1,
  title: "Lot expiry warnings",
  description:
    "Active / on-hold inventory lots that are expired or expiring within a horizon (default 90 days), most-urgent first. Excludes depleted lots.",
  parametersSchema: paramsSchema,
  parameterFields: [
    {
      kind: "number",
      key: "withinDays",
      label: "Within days",
      required: false,
      help: "Expiry horizon in days (default 90). Already-expired lots are always included.",
      min: 1,
      max: 3650,
      defaultValue: 90,
    },
  ],

  async run(ctx, params): Promise<ReportResult<LotExpiryWarningRow>> {
    const asOf = ctx.asOf ?? new Date();
    const horizon = new Date(asOf.getTime() + params.withinDays * DAY_MS);

    // The index `(organizationId, siteId, status, expirationDate)`
    // covers this range scan. We bound the UPPER edge at the
    // horizon; the lower edge is open (already-expired lots are
    // included by design).
    const lots = await ctx.client.lot.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { in: [LotStatus.ACTIVE, LotStatus.ON_HOLD] },
        expirationDate: { lte: horizon },
      },
      select: {
        siteId: true,
        productId: true,
        lotNumber: true,
        expirationDate: true,
        status: true,
        product: { select: { name: true } },
      },
      orderBy: { expirationDate: "asc" },
    });

    // Anchor "today" at UTC midnight so daysUntilExpiry is a clean
    // integer day count against the date-typed expirationDate.
    const todayMidnightMs = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());

    const rows: LotExpiryWarningRow[] = lots.map((lot) => {
      const expMs = Date.UTC(
        lot.expirationDate.getUTCFullYear(),
        lot.expirationDate.getUTCMonth(),
        lot.expirationDate.getUTCDate()
      );
      const daysUntilExpiry = Math.round((expMs - todayMidnightMs) / DAY_MS);
      return Object.freeze({
        siteId: lot.siteId,
        productId: lot.productId,
        productName: lot.product.name,
        lotNumber: lot.lotNumber,
        expirationDate: lot.expirationDate.toISOString().slice(0, 10),
        status: lot.status,
        daysUntilExpiry,
      });
    });

    const expiredCount = rows.reduce((n, r) => (r.daysUntilExpiry < 0 ? n + 1 : n), 0);
    const expiringSoonCount = rows.reduce(
      (n, r) => (r.daysUntilExpiry >= 0 && r.daysUntilExpiry <= 30 ? n + 1 : n),
      0
    );

    return Object.freeze({
      rows,
      aggregates: Object.freeze({
        totalCount: rows.length,
        expiredCount,
        expiringSoonCount,
      }),
      window: { from: asOf, to: horizon },
      generatedAt: asOf,
    });
  },
};
