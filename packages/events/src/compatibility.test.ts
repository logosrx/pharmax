// Compatibility checker tests.
//
// One green case + one red case per kind, so each rule's boundary
// is exercised independently.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { assertEventCompatibility, diffEventSchemas } from "./compatibility.js";
import { defineEvent } from "./define-event.js";

const V1 = defineEvent({
  name: "sample.event",
  version: 1,
  aggregateType: "Order",
  schema: z
    .object({
      orderId: z.uuid(),
      shippedAt: z.iso.datetime({ offset: true }),
      optionalNote: z.string().optional(),
    })
    .strict(),
  aggregateIdFrom: (p) => p.orderId,
  description: "v1",
});

function makeV2(schema: z.ZodObject) {
  return defineEvent({
    name: "sample.event",
    version: 2,
    aggregateType: "Order",
    schema,
    aggregateIdFrom: (p) => p["orderId"] as string,
    description: "v2",
  });
}

describe("compatibility — backward", () => {
  it("passes when v2 adds an optional field", () => {
    const v2 = makeV2(
      z
        .object({
          orderId: z.uuid(),
          shippedAt: z.iso.datetime({ offset: true }),
          optionalNote: z.string().optional(),
          newOptional: z.string().optional(),
        })
        .strict()
    );
    const res = assertEventCompatibility(V1, v2, "backward");
    expect(res.compatible).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it("fails when v2 adds a required field (old payloads omit it)", () => {
    const v2 = makeV2(
      z
        .object({
          orderId: z.uuid(),
          shippedAt: z.iso.datetime({ offset: true }),
          optionalNote: z.string().optional(),
          newRequired: z.string(),
        })
        .strict()
    );
    const res = assertEventCompatibility(V1, v2, "backward");
    expect(res.compatible).toBe(false);
    expect(res.violations[0]?.kind).toBe("field_added_required");
    expect(res.violations[0]?.path).toBe("newRequired");
  });

  it("fails when v2 makes an optional field required", () => {
    const v2 = makeV2(
      z
        .object({
          orderId: z.uuid(),
          shippedAt: z.iso.datetime({ offset: true }),
          optionalNote: z.string(),
        })
        .strict()
    );
    const res = assertEventCompatibility(V1, v2, "backward");
    expect(res.compatible).toBe(false);
    expect(res.violations[0]?.kind).toBe("field_optional_to_required");
  });
});

describe("compatibility — forward", () => {
  it("passes when v2 adds an optional field", () => {
    const v2 = makeV2(
      z
        .object({
          orderId: z.uuid(),
          shippedAt: z.iso.datetime({ offset: true }),
          optionalNote: z.string().optional(),
          newOptional: z.string().optional(),
        })
        .strict()
    );
    expect(assertEventCompatibility(V1, v2, "forward").compatible).toBe(true);
  });

  it("fails when v2 removes a field old consumers expected", () => {
    const v2 = makeV2(
      z
        .object({
          orderId: z.uuid(),
          shippedAt: z.iso.datetime({ offset: true }),
        })
        .strict()
    );
    const res = assertEventCompatibility(V1, v2, "forward");
    expect(res.compatible).toBe(false);
    expect(res.violations[0]?.kind).toBe("field_removed");
    expect(res.violations[0]?.path).toBe("optionalNote");
  });

  it("fails when v2 makes a required field optional", () => {
    const v2 = makeV2(
      z
        .object({
          orderId: z.uuid().optional(),
          shippedAt: z.iso.datetime({ offset: true }),
          optionalNote: z.string().optional(),
        })
        .strict()
    );
    const res = assertEventCompatibility(V1, v2, "forward");
    expect(res.compatible).toBe(false);
    expect(res.violations[0]?.kind).toBe("field_required_to_optional");
  });
});

describe("compatibility — full", () => {
  it("passes only when both forward and backward pass", () => {
    const v2 = makeV2(
      z
        .object({
          orderId: z.uuid(),
          shippedAt: z.iso.datetime({ offset: true }),
          optionalNote: z.string().optional(),
          newOptional: z.string().optional(),
        })
        .strict()
    );
    const res = assertEventCompatibility(V1, v2, "full");
    expect(res.compatible).toBe(true);
  });

  it("fails when either direction is broken", () => {
    const addedRequired = makeV2(
      z
        .object({
          orderId: z.uuid(),
          shippedAt: z.iso.datetime({ offset: true }),
          optionalNote: z.string().optional(),
          newRequired: z.string(),
        })
        .strict()
    );
    expect(assertEventCompatibility(V1, addedRequired, "full").compatible).toBe(false);

    const removedOptional = makeV2(
      z
        .object({
          orderId: z.uuid(),
          shippedAt: z.iso.datetime({ offset: true }),
        })
        .strict()
    );
    expect(assertEventCompatibility(V1, removedOptional, "full").compatible).toBe(false);
  });
});

describe("compatibility — field-type changes", () => {
  it("reports a type change in either direction", () => {
    const v2 = makeV2(
      z
        .object({
          orderId: z.number(), // was uuid string
          shippedAt: z.iso.datetime({ offset: true }),
          optionalNote: z.string().optional(),
        })
        .strict()
    );
    const forward = assertEventCompatibility(V1, v2, "forward");
    const backward = assertEventCompatibility(V1, v2, "backward");
    expect(forward.compatible).toBe(false);
    expect(backward.compatible).toBe(false);
    const violation = forward.violations.find((v) => v.kind === "field_type_changed");
    expect(violation?.path).toBe("orderId");
  });
});

describe("diffEventSchemas", () => {
  it("returns an empty diff for identical schemas", () => {
    const v1Again = defineEvent({
      name: "sample.event",
      version: 2,
      aggregateType: "Order",
      schema: V1.schema,
      aggregateIdFrom: (p) => p["orderId"] as string,
      description: "v2",
    });
    expect(diffEventSchemas(V1, v1Again)).toEqual([]);
  });
});
