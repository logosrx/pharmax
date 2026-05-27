// Unit tests for defineEvent, validateAgainst, and the introspection
// helpers. All assertions are pure-function tests — no filesystem,
// no DB.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEvent,
  EVENT_NAME_REGEX,
  getZodTypeName,
  isFieldOptional,
  isZodObject,
  validateAgainst,
} from "./define-event.js";

const sampleSchema = z
  .object({
    orderId: z.uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
    optionalNote: z.string().optional(),
  })
  .strict();

describe("defineEvent", () => {
  it("freezes the returned definition and composes fullName", () => {
    const def = defineEvent({
      name: "order.shipped",
      version: 1,
      aggregateType: "Order",
      schema: sampleSchema,
      aggregateIdFrom: (p) => p.orderId,
      description: "sample",
    });
    expect(def.fullName).toBe("order.shipped.v1");
    expect(Object.isFrozen(def)).toBe(true);
  });

  it("rejects a name that already includes a .v{n} suffix", () => {
    expect(() =>
      defineEvent({
        name: "order.shipped.v1",
        version: 1,
        aggregateType: "Order",
        schema: sampleSchema,
        aggregateIdFrom: (p) => p.orderId,
        description: "x",
      })
    ).toThrowError(/must not include the ".v\{n\}" suffix/);
  });

  it("rejects a name with no dotted segments", () => {
    expect(() =>
      defineEvent({
        name: "order",
        version: 1,
        aggregateType: "Order",
        schema: sampleSchema,
        aggregateIdFrom: (p) => p.orderId,
        description: "x",
      })
    ).toThrowError(/must contain at least one dotted segment/);
  });

  it("rejects a name with an uppercase segment", () => {
    expect(() =>
      defineEvent({
        name: "Order.Shipped",
        version: 1,
        aggregateType: "Order",
        schema: sampleSchema,
        aggregateIdFrom: (p) => p.orderId,
        description: "x",
      })
    ).toThrowError(/invalid segment/);
  });

  it("rejects a non-positive version", () => {
    expect(() =>
      defineEvent({
        name: "order.shipped",
        version: 0,
        aggregateType: "Order",
        schema: sampleSchema,
        aggregateIdFrom: (p) => p.orderId,
        description: "x",
      })
    ).toThrowError(/positive integer/);
  });

  it("rejects a non-ZodObject schema", () => {
    expect(() =>
      defineEvent({
        name: "order.shipped",
        version: 1,
        aggregateType: "Order",
        // Cast through unknown so the failure shape (not the type check)
        // is what's under test.
        schema: z.string() as unknown as z.ZodObject<Record<string, never>>,
        aggregateIdFrom: () => "x",
        description: "x",
      })
    ).toThrowError(/must be a ZodObject/);
  });

  it("EVENT_NAME_REGEX accepts canonical full names", () => {
    expect(EVENT_NAME_REGEX.test("order.shipped.v1")).toBe(true);
    expect(EVENT_NAME_REGEX.test("billing.invoice_line.created.v1")).toBe(true);
    expect(EVENT_NAME_REGEX.test("a.b.v99")).toBe(true);
  });

  it("EVENT_NAME_REGEX rejects malformed names", () => {
    expect(EVENT_NAME_REGEX.test("Order.Shipped.v1")).toBe(false);
    expect(EVENT_NAME_REGEX.test("order.shipped")).toBe(false);
    expect(EVENT_NAME_REGEX.test("order.shipped.v")).toBe(false);
    expect(EVENT_NAME_REGEX.test("order.shipped.v01")).toBe(true); // version is just \d+
  });
});

describe("validateAgainst", () => {
  const def = defineEvent({
    name: "sample.event",
    version: 1,
    aggregateType: "Order",
    schema: sampleSchema,
    aggregateIdFrom: (p) => p.orderId,
    description: "x",
  });

  it("returns ok: true for a valid payload", () => {
    const res = validateAgainst(def, {
      orderId: "00000000-0000-4000-8000-000000000000",
      occurredAt: "2026-05-25T10:00:00.000Z",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.orderId).toBe("00000000-0000-4000-8000-000000000000");
    }
  });

  it("returns ok: false with structured issues on schema mismatch", () => {
    const res = validateAgainst(def, {
      orderId: "not-a-uuid",
      occurredAt: "yesterday",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.length).toBeGreaterThan(0);
      expect(res.issues[0]?.path).toBeInstanceOf(Array);
    }
  });

  it("rejects extra top-level keys (strict mode)", () => {
    const res = validateAgainst(def, {
      orderId: "00000000-0000-4000-8000-000000000000",
      occurredAt: "2026-05-25T10:00:00.000Z",
      somethingExtra: 1,
    });
    expect(res.ok).toBe(false);
  });
});

describe("Zod introspection helpers", () => {
  it("isZodObject recognizes ZodObject and rejects others", () => {
    expect(isZodObject(z.object({}))).toBe(true);
    expect(isZodObject(z.string())).toBe(false);
    expect(isZodObject(null)).toBe(false);
    expect(isZodObject(undefined)).toBe(false);
    expect(isZodObject({})).toBe(false);
  });

  it("isFieldOptional returns true for ZodOptional and false otherwise", () => {
    expect(isFieldOptional(z.string().optional())).toBe(true);
    expect(isFieldOptional(z.string())).toBe(false);
    expect(isFieldOptional(null)).toBe(false);
  });

  it("getZodTypeName returns the runtime constructor name", () => {
    expect(getZodTypeName(z.string())).toBe("ZodString");
    expect(getZodTypeName(z.object({}))).toBe("ZodObject");
    expect(getZodTypeName(null)).toBeUndefined();
    expect(getZodTypeName({})).toBeUndefined();
  });
});
