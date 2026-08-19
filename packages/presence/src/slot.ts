import { PRESENCE_SLOT_MS } from "./constants.js";

/**
 * Floor an instant onto the presence slot grid.
 *
 * The grid is anchored at the Unix epoch, not at the operator's first
 * beat, so two clients beating at different offsets inside the same
 * five minutes resolve to the SAME slot and therefore the same row.
 * An operator-relative anchor would give every browser tab its own
 * grid and quietly multiply the row count by the number of tabs —
 * which is the unbounded-growth failure this design exists to avoid.
 */
export function presenceSlotStart(at: Date, slotMs: number = PRESENCE_SLOT_MS): Date {
  if (!Number.isFinite(slotMs) || slotMs <= 0) {
    throw new RangeError(`slotMs must be a positive finite number (got ${slotMs})`);
  }
  const ms = at.getTime();
  return new Date(Math.floor(ms / slotMs) * slotMs);
}
