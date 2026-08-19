import { describe, expect, it } from "vitest";

import { PRESENCE_SLOT_MS } from "./constants.js";
import { presenceSlotStart } from "./slot.js";

describe("presenceSlotStart", () => {
  it("floors to the epoch-anchored slot grid", () => {
    // 10:07:31 with a 5-minute grid floors to 10:05:00.
    const at = new Date("2026-03-04T10:07:31.482Z");
    expect(presenceSlotStart(at).toISOString()).toBe("2026-03-04T10:05:00.000Z");
  });

  it("is exact on a slot boundary (boundary belongs to the slot it opens)", () => {
    const at = new Date("2026-03-04T10:05:00.000Z");
    expect(presenceSlotStart(at).toISOString()).toBe("2026-03-04T10:05:00.000Z");
  });

  it("maps every instant inside one slot to the same value", () => {
    // The property the row count depends on: two clients beating at
    // different offsets inside one slot must collide on one row.
    const base = new Date("2026-03-04T10:05:00.000Z").getTime();
    const slots = new Set<number>();
    for (let offset = 0; offset < PRESENCE_SLOT_MS; offset += 7_919) {
      slots.add(presenceSlotStart(new Date(base + offset)).getTime());
    }
    expect(slots.size).toBe(1);
    expect([...slots][0]).toBe(base);
  });

  it("advances to the next slot exactly one slot width later", () => {
    const base = new Date("2026-03-04T10:05:00.000Z").getTime();
    const next = presenceSlotStart(new Date(base + PRESENCE_SLOT_MS));
    expect(next.getTime() - base).toBe(PRESENCE_SLOT_MS);
  });

  it("rejects a non-positive slot width rather than dividing by zero", () => {
    expect(() => presenceSlotStart(new Date(), 0)).toThrow(RangeError);
    expect(() => presenceSlotStart(new Date(), -1)).toThrow(RangeError);
  });
});
