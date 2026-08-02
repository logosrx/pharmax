// POST /api/ops/orders/:orderId/complete-fill
//
// Tech scans every printed vial label + assigned lot barcode to
// finalize the fill. The command runs strict scan validation:
//   - Each `lotScan` must match the assigned lot's identifying
//     barcode (lot number / GS1 batch / NDC depending on parser).
//   - Each `vialLabelScan` must match the line's printed vial
//     label barcode.
//   - Every order line must be present exactly once in lineScans
//     (no duplicates, no missing lines).
// Mismatch returns a typed `FILL_SCAN_*` error code from
// `@pharmax/scan` which surfaces back to the page as a flash
// error.
//
// On success the order transitions FILL_IN_PROGRESS → FILL_COMPLETED_READY_FOR_FINAL
// and is moved to the FINAL bucket.
//
// FORM SHAPE: the workbench renders inputs named
//   lineScans[0][orderLineId], lineScans[0][lotScan], lineScans[0][vialLabelScan],
//   lineScans[1][orderLineId], ...
// The parser below reconstructs an array from those flat keys.
//
// RBAC enforced by the command (`fill.complete` permission).

import { CompleteFill } from "@pharmax/fill";

import { dispatchOpsCommand } from "../../../../../../src/server/ops/dispatch-from-route.js";

interface RouteParams {
  readonly params: Promise<{ readonly orderId: string }>;
}

interface ParsedLineScan {
  readonly orderLineId: string;
  /** Absent for compound-prep lines (no finished-goods lot to scan). */
  readonly lotScan?: string;
  readonly vialLabelScan: string;
}

const LINE_SCAN_RE = /^lineScans\[(\d+)\]\[(orderLineId|lotScan|vialLabelScan)\]$/;

// Partial-fill declarations for controlled-substance lines (ADR-0037).
// Kept separate from `lineScans` because a scan is physical
// verification and a basis is a regulatory assertion — see the note on
// the command's input schema.
//
// FORM SHAPE: partialFills[<orderLineId>] = <basis>. Keying by line id
// rather than by index means a blank select simply produces no entry,
// so the common case (complete fill) submits nothing at all.
const PARTIAL_FILL_RE = /^partialFills\[([0-9a-fA-F-]{36})\]$/;

function parsePartialFills(
  entries: ReadonlyArray<readonly [string, unknown]>
): ReadonlyArray<{ readonly orderLineId: string; readonly basis: string }> {
  const out: Array<{ orderLineId: string; basis: string }> = [];
  for (const [key, raw] of entries) {
    const match = PARTIAL_FILL_RE.exec(key);
    if (match === null) continue;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value.length === 0) continue;
    out.push({ orderLineId: match[1]!, basis: value });
  }
  return out;
}

function parseLineScans(
  body: FormData | Record<string, unknown>
): ReadonlyArray<ParsedLineScan> | { readonly error: string } {
  const buckets = new Map<
    number,
    { orderLineId?: string; lotScan?: string; vialLabelScan?: string }
  >();

  const entries: ReadonlyArray<readonly [string, unknown]> =
    body instanceof FormData
      ? Array.from(body.entries()).map(([k, v]) => [k, v] as const)
      : Object.entries(body as Record<string, unknown>);

  for (const [key, raw] of entries) {
    const match = LINE_SCAN_RE.exec(key);
    if (match === null) continue;
    const idx = Number(match[1]);
    const field = match[2] as "orderLineId" | "lotScan" | "vialLabelScan";
    const value = typeof raw === "string" ? raw : "";
    if (value.length === 0) continue;
    const bucket = buckets.get(idx) ?? {};
    bucket[field] = value;
    buckets.set(idx, bucket);
  }

  if (buckets.size === 0) {
    return { error: "No scan inputs were submitted." };
  }

  const indices = Array.from(buckets.keys()).sort((a, b) => a - b);
  const out: ParsedLineScan[] = [];
  for (const idx of indices) {
    const bucket = buckets.get(idx)!;
    // lotScan is intentionally optional: compound-prep lines (ADR-0035
    // slice 4) have no finished-goods lot — the command enforces
    // required/forbidden per line kind.
    if (bucket.orderLineId === undefined || bucket.vialLabelScan === undefined) {
      return {
        error: `Line ${idx + 1}: orderLineId and vialLabelScan are required.`,
      };
    }
    out.push(
      Object.freeze({
        orderLineId: bucket.orderLineId,
        ...(bucket.lotScan !== undefined ? { lotScan: bucket.lotScan } : {}),
        vialLabelScan: bucket.vialLabelScan,
      })
    );
  }

  return Object.freeze(out);
}

export async function POST(request: Request, context: RouteParams): Promise<Response> {
  const { orderId } = await context.params;
  return await dispatchOpsCommand({
    request,
    command: CompleteFill,
    idempotencyKeyPrefix: `route:complete-fill:${orderId}`,
    buildInput: ({ body }) => {
      const parsed = parseLineScans(body);
      if ("error" in parsed) return { error: parsed.error };
      const entries: ReadonlyArray<readonly [string, unknown]> =
        body instanceof FormData
          ? Array.from(body.entries()).map(([k, v]) => [k, v] as const)
          : Object.entries(body as Record<string, unknown>);
      const partialFills = parsePartialFills(entries);
      // Spread into mutable arrays to satisfy CompleteFillInput's
      // non-readonly array shape (Zod infers a mutable array even
      // though we treat these as immutable in this layer). The basis
      // strings stay unvalidated here on purpose — the command's Zod
      // enum is the gate, so an unknown value fails as a typed
      // validation error rather than a hand-rolled string check.
      return {
        orderId,
        lineScans: [...parsed],
        ...(partialFills.length > 0
          ? { partialFills: partialFills.map((p) => ({ ...p, basis: p.basis as never })) }
          : {}),
      };
    },
    successRedirect: () => `/ops/fill?flash=fill_completed&orderId=${orderId}`,
    failureRedirect: `/ops/fill/${orderId}`,
    successLogEvent: "ops.fill.complete.applied",
    failureLogEvent: "ops.fill.complete.failed",
  });
}
