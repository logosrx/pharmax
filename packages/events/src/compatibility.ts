// assertEventCompatibility — checks Zod schema evolution rules.
//
// Why this exists:
//
//   When we ship `order.shipped.v2`, we need to be deliberate about
//   whether the new shape can be:
//
//     (a) "backward-compatible" — a v2-aware consumer can read v1
//         payloads emitted by old producers (during a rolling
//         deploy). Backward compatibility means **v2 added no new
//         required fields**: every payload the old shape produced
//         must still validate against the new shape.
//
//     (b) "forward-compatible" — a v1-aware consumer can read v2
//         payloads emitted by new producers (during the same
//         rolling deploy). Forward compatibility means **v2 did
//         not remove any field** the old consumer relied on:
//         every key v1 declared must still be present (required
//         OR optional) in v2.
//
//     (c) "full" — both. The deployment order does not matter; old
//         and new producers/consumers can coexist indefinitely.
//
//   The "breaking" kind is the absence of all of the above: e.g.
//   renamed a field, changed a string → number, removed a required
//   field. Breaking changes are legitimate — they just require a
//   new major version (`v2`) and a coordinated cutover (both
//   versions live in the registry; consumers switch over; old
//   version retires).
//
// PHI invariant: this file does NOT read payloads. It reads
// schema definitions (key names, optionality, field-level Zod
// type names). Nothing here can leak PHI by construction.
//
// What this is NOT:
//   - A semantic checker. We do not enforce that "removing
//     `clinicId`" is a workflow bug; that's a domain conversation,
//     not a schema-shape rule.
//   - A full JSON-Schema diff. We compare ZodObject shapes at
//     one level (field name + required/optional + ZodType name).
//     Nested objects are checked recursively. Unions and arrays
//     are compared by type name only — deeper diffing is a follow-
//     up if breakage shows up there.

import {
  type EventDefinition,
  isFieldOptional,
  isZodObject,
  getZodTypeName,
} from "./define-event.js";

export type CompatibilityKind = "forward" | "backward" | "full";

/**
 * Single difference between two schemas. Reported back to the
 * caller so the test failure pinpoints which field changed and
 * how — not just "incompatible".
 */
export interface SchemaDifference {
  readonly path: string;
  readonly kind:
    | "field_added_required"
    | "field_added_optional"
    | "field_removed"
    | "field_required_to_optional"
    | "field_optional_to_required"
    | "field_type_changed";
  readonly previous?: string;
  readonly next?: string;
}

export interface CompatibilityResult {
  readonly kind: CompatibilityKind;
  readonly compatible: boolean;
  readonly violations: ReadonlyArray<SchemaDifference>;
  /** All differences, including ones that don't violate `kind`. */
  readonly differences: ReadonlyArray<SchemaDifference>;
}

/**
 * Compare two schemas at one level. Returns every difference; the
 * top-level orchestrator classifies which ones violate the
 * requested compatibility kind.
 *
 * `path` is the dotted accessor (`"clinicId"` at top level,
 * `"shipment.trackingNumber"` for a nested object). Empty string
 * for the root object.
 */
function diffObjects(
  prev: unknown,
  next: unknown,
  pathPrefix: string,
  out: SchemaDifference[]
): void {
  if (!isZodObject(prev) || !isZodObject(next)) {
    // Comparing non-objects at this level is a type change; record
    // and stop recursing (we don't descend through union/array
    // shapes).
    const prevName = getZodTypeName(prev);
    const nextName = getZodTypeName(next);
    if (prevName !== nextName) {
      out.push({
        path: pathPrefix === "" ? "(root)" : pathPrefix,
        kind: "field_type_changed",
        ...(prevName === undefined ? {} : { previous: prevName }),
        ...(nextName === undefined ? {} : { next: nextName }),
      });
    }
    return;
  }
  // `shape` on ZodObject is `{ [k: string]: ZodType }`. We cast
  // narrowly so we can iterate keys without leaking unknown all the
  // way down.
  const prevShape = (prev as unknown as { shape: Record<string, unknown> }).shape;
  const nextShape = (next as unknown as { shape: Record<string, unknown> }).shape;

  const prevKeys = new Set(Object.keys(prevShape));
  const nextKeys = new Set(Object.keys(nextShape));

  // Added fields (in next, not in prev).
  for (const key of nextKeys) {
    if (prevKeys.has(key)) continue;
    const field = nextShape[key];
    const optional = isFieldOptional(field);
    const nextName = getZodTypeName(field);
    out.push({
      path: composePath(pathPrefix, key),
      kind: optional ? "field_added_optional" : "field_added_required",
      ...(nextName === undefined ? {} : { next: nextName }),
    });
  }

  // Removed fields (in prev, not in next).
  for (const key of prevKeys) {
    if (nextKeys.has(key)) continue;
    const prevName = getZodTypeName(prevShape[key]);
    out.push({
      path: composePath(pathPrefix, key),
      kind: "field_removed",
      ...(prevName === undefined ? {} : { previous: prevName }),
    });
  }

  // Fields present in both — compare optionality + type, recurse
  // into nested objects.
  for (const key of nextKeys) {
    if (!prevKeys.has(key)) continue;
    const prevField = prevShape[key];
    const nextField = nextShape[key];
    const prevOptional = isFieldOptional(prevField);
    const nextOptional = isFieldOptional(nextField);
    if (prevOptional && !nextOptional) {
      const prevName = getZodTypeName(prevField);
      const nextName = getZodTypeName(nextField);
      out.push({
        path: composePath(pathPrefix, key),
        kind: "field_optional_to_required",
        ...(prevName === undefined ? {} : { previous: prevName }),
        ...(nextName === undefined ? {} : { next: nextName }),
      });
    } else if (!prevOptional && nextOptional) {
      const prevName = getZodTypeName(prevField);
      const nextName = getZodTypeName(nextField);
      out.push({
        path: composePath(pathPrefix, key),
        kind: "field_required_to_optional",
        ...(prevName === undefined ? {} : { previous: prevName }),
        ...(nextName === undefined ? {} : { next: nextName }),
      });
    }
    // For nested-object recursion we unwrap ZodOptional. We don't
    // have a Zod 4 surface for that without `_def`, so we just
    // compare type names; if either side is a ZodObject we recurse,
    // otherwise we compare names.
    const prevInner = unwrapOptional(prevField);
    const nextInner = unwrapOptional(nextField);
    const prevInnerName = getZodTypeName(prevInner);
    const nextInnerName = getZodTypeName(nextInner);
    if (prevInnerName !== nextInnerName) {
      out.push({
        path: composePath(pathPrefix, key),
        kind: "field_type_changed",
        ...(prevInnerName === undefined ? {} : { previous: prevInnerName }),
        ...(nextInnerName === undefined ? {} : { next: nextInnerName }),
      });
      continue;
    }
    if (isZodObject(prevInner) && isZodObject(nextInner)) {
      diffObjects(prevInner, nextInner, composePath(pathPrefix, key), out);
    }
  }
}

function composePath(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

/**
 * Unwrap a `ZodOptional<T>` one level. Returns the inner schema
 * for type-name comparison and nested-object recursion. Other Zod
 * wrappers (`ZodNullable`, `ZodDefault`) are intentionally not
 * unwrapped here — those are semantic differences worth surfacing
 * as `field_type_changed`.
 */
function unwrapOptional(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema;
  if (getZodTypeName(schema) !== "ZodOptional") return schema;
  // Zod 4's ZodOptional exposes `unwrap()` on the public surface.
  const candidate = schema as { unwrap?: () => unknown };
  if (typeof candidate.unwrap === "function") {
    try {
      return candidate.unwrap();
    } catch {
      return schema;
    }
  }
  return schema;
}

/**
 * Compute every difference between two definitions. Pure
 * comparison; classification into "violation" happens below in
 * `assertEventCompatibility`.
 *
 * The signature is generic over both payload types so callers can
 * pass concrete `EventDefinition<OrderShippedV1Payload>` instances
 * directly. The checker introspects schemas, not payloads, so the
 * payload type parameter is invariant to the comparison logic.
 */
export function diffEventSchemas<
  TPrev extends Record<string, unknown>,
  TNext extends Record<string, unknown>,
>(prev: EventDefinition<TPrev>, next: EventDefinition<TNext>): ReadonlyArray<SchemaDifference> {
  const out: SchemaDifference[] = [];
  diffObjects(prev.schema, next.schema, "", out);
  return out;
}

/**
 * Check whether `next` is compatible with `prev` under the
 * requested `kind`. Returns the structured result; the caller (test
 * or migration script) decides whether to throw.
 *
 * Rules:
 *
 *   - `backward`: a v(next) consumer can read v(prev) payloads.
 *     Disallowed: any required field added (a v(prev) payload won't
 *     have it), any required field type-changed (v(prev) value
 *     won't validate), any field optional→required (v(prev) may
 *     omit it).
 *
 *   - `forward`: a v(prev) consumer can read v(next) payloads.
 *     Disallowed: any field removed (v(prev) consumer expected
 *     it), any required→optional change THAT IS ALSO observable as
 *     missing (we treat any required→optional as forward-incompat
 *     because v(prev) consumers may dereference the field
 *     unguardedly), any type change (v(prev) consumer's type
 *     assumption fails).
 *
 *   - `full`: union of the two — everything must be a no-op or an
 *     optional-field-add.
 */
export function assertEventCompatibility<
  TPrev extends Record<string, unknown>,
  TNext extends Record<string, unknown>,
>(
  prev: EventDefinition<TPrev>,
  next: EventDefinition<TNext>,
  kind: CompatibilityKind
): CompatibilityResult {
  const differences = diffEventSchemas(prev, next);
  const violations: SchemaDifference[] = [];
  for (const diff of differences) {
    if (isViolation(diff, kind)) {
      violations.push(diff);
    }
  }
  return {
    kind,
    compatible: violations.length === 0,
    violations,
    differences,
  };
}

function isViolation(diff: SchemaDifference, kind: CompatibilityKind): boolean {
  switch (diff.kind) {
    case "field_added_optional":
      // Adding an optional field is the textbook safe change.
      return false;
    case "field_added_required":
      // Backward-breaking: prev payloads omit it.
      return kind === "backward" || kind === "full";
    case "field_removed":
      // Forward-breaking: prev consumers expect it.
      return kind === "forward" || kind === "full";
    case "field_required_to_optional":
      // Forward-breaking: prev consumers may dereference unguarded.
      return kind === "forward" || kind === "full";
    case "field_optional_to_required":
      // Backward-breaking: prev payloads may omit it.
      return kind === "backward" || kind === "full";
    case "field_type_changed":
      // Both sides — type-strict consumers fail either way.
      return true;
  }
}
