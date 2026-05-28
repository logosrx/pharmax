// defineEvent — declarative factory for outbox event definitions.
//
// Why this exists:
//
//   Today, outbox events like `order.shipped.v1` and
//   `billing.invoice.finalized.v1` are emitted as `{ eventType,
//   aggregateType, aggregateId, payload }` object literals inside
//   command handlers. The event name is a string literal, the
//   payload is a free-form `Record<string, unknown>`, and there
//   is no central contract.
//
//   That works while the payload shape is small and stable, but
//   it makes safe schema evolution impossible:
//
//     - A handler adding a required field to `order.shipped.v1`
//       silently breaks every existing consumer the moment the
//       outbox dispatches a fresh row to a consumer that hasn't
//       redeployed.
//     - Removing an optional field that a consumer reads is the
//       symmetric break (forward-incompatible).
//     - Two services emitting "the same event" with different
//       payload shapes (typo in field name, missing id) fail at
//       consumer-runtime instead of producer-typecheck.
//
//   `EventDefinition` is the seam that makes those failures
//   impossible at compile time and observable at validation time:
//
//     - A definition pairs a `name` + `version` with a Zod schema
//       for the payload. The name + version compose into the
//       outbox `eventType` (`order.shipped.v1`).
//     - The schema is restricted to `ZodObject` so the
//       compatibility checker can introspect fields. Non-object
//       payloads are explicitly out of scope (every existing
//       outbox payload is an object; that constraint stays).
//     - `aggregateIdFrom` is a selector that pulls the aggregate
//       id off the typed payload so the `emit()` helper can build
//       a full outbox draft from `(definition, payload)` alone.
//
// PHI rule: nothing in this file reads PHI. Definitions are
// vocabulary; payloads (which carry the per-event data) are
// declared by the schema and validated against it. The PHI rules
// in `.cursor/rules/02-security-compliance.mdc` still apply to
// callers — definitions are payload-shape declarations, not
// payload-content declarations.

import type { z, ZodObject, ZodType } from "zod";

/**
 * Outbox event draft shape. Structurally compatible with
 * `OutboxEventDraft` from `@pharmax/command-bus`. We re-declare
 * here so `@pharmax/events` does not depend on `@pharmax/command-bus`
 * (the bus is a downstream consumer of vocabulary; the vocabulary
 * cannot depend on the bus without a cycle).
 *
 * Fields:
 *   - `eventType`     — the full versioned name (`order.shipped.v1`).
 *   - `aggregateType` — the aggregate kind (`Order`, `Invoice`, ...).
 *   - `aggregateId`   — the specific aggregate row id.
 *   - `payload`       — the validated, PHI-redacted JSON payload.
 */
export interface OutboxEventDraft {
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Retention policies for outbox / audit-archive lifecycle.
 *
 * The audit-archive S3 lifecycle policy keys on this field to
 * decide when a row can be tiered out of hot storage (S3 →
 * Glacier) and when it can be permanently expired. See ADR 0024
 * (Merkle root signing and evidence) and the S3 lifecycle docs
 * under `docs/security/`.
 *
 * Values:
 *   - `"7y"`  — HIPAA-grade events. Every workflow audit signal
 *               (orders, verification, fill, ship), billing /
 *               financial events, PHI-related actions (view,
 *               update, crypto-shred), provider/patient roster
 *               mutations, and tenant administration events. The
 *               7-year window matches the HIPAA documentation
 *               retention requirement (45 CFR 164.316).
 *   - `"90d"` — Operational signals that drive dashboards and
 *               counters but are NOT audit-grade. Worker logs,
 *               cache-warm pings, etc. Reserved; no event uses
 *               this today.
 *   - `"30d"` — Telemetry / metrics only. Reserved; no event uses
 *               this today.
 */
export type EventRetention = "7y" | "90d" | "30d";

/** Domain owner — used by docs generation and on-call routing. */
export type EventOwner =
  | "orders"
  | "verification"
  | "fill"
  | "shipping"
  | "labels"
  | "billing"
  | "patients"
  | "providers"
  | "orgs"
  | "notifications"
  | "sla"
  | "security"
  | "audit"
  | "workflow"
  | "system";

/**
 * Specification for `defineEvent`. The factory returns a frozen
 * `EventDefinition<TPayload>` where `TPayload` is inferred from
 * the schema (`z.infer<typeof spec.schema>`).
 *
 * Constraints:
 *   - `name` MUST be the dotted prefix WITHOUT the `.v{n}` suffix
 *     (e.g. `"order.shipped"`, not `"order.shipped.v1"`). The
 *     suffix is composed from `version`.
 *   - `version` MUST be a positive integer. New shapes get a new
 *     version, not a mutated schema.
 *   - `schema` MUST be a `ZodObject` so the compatibility checker
 *     can introspect fields. Other Zod types (`ZodArray`,
 *     `ZodUnion`, etc.) are intentionally rejected — every
 *     existing outbox payload is an object, and that constraint
 *     keeps the compatibility checker tractable.
 *   - `aggregateIdFrom` is a selector from `TPayload → string`.
 *     The `emit()` helper invokes it to build the outbox draft.
 *   - `description` is a short human-readable string surfaced in
 *     the registry's introspection helpers (and useful for ADRs).
 *   - `owner` is the domain that owns the producer command. Used
 *     by the generated catalog and on-call routing.
 *   - `retention` controls audit-archive S3 lifecycle. Defaults to
 *     `"7y"` if omitted — the safe default for HIPAA-adjacent
 *     workflow signals. Set explicitly to `"90d"` or `"30d"` for
 *     non-audit operational events.
 *   - `phiSafe` is `true` when the payload (envelope + data) is
 *     guaranteed to contain NO PHI. Defaults to `true`; setting
 *     `false` is an explicit acknowledgement that this event MAY
 *     carry PHI and must be handled by PHI-capable consumers
 *     only. **No event in the registry today is PHI-bearing**;
 *     the flag exists so a future need is an explicit, reviewed
 *     change.
 *   - `routingKey` (optional) is a downstream filter hint. Pub/sub
 *     bridges (CloudEvents, BI ingestion) read this off the
 *     definition to route events without re-parsing the name.
 */
export interface DefineEventSpec<TSchema extends ZodObject> {
  readonly name: string;
  readonly version: number;
  readonly aggregateType: string;
  readonly schema: TSchema;
  readonly aggregateIdFrom: (payload: z.infer<TSchema>) => string;
  readonly description: string;
  readonly owner?: EventOwner;
  readonly retention?: EventRetention;
  readonly phiSafe?: boolean;
  readonly routingKey?: string;
}

/**
 * A registered event definition. Frozen at creation time so callers
 * cannot mutate the shared registry by side effect.
 *
 * The `fullName` is the concatenation `${name}.v${version}` and is
 * the key under which the definition is registered in
 * `EVENT_REGISTRY`. Consumers and the parity guard both key on
 * `fullName`.
 *
 * Unlike `DefineEventSpec`, the metadata fields are REQUIRED on the
 * resolved definition — `defineEvent` fills in defaults so every
 * registry entry has a complete owner / retention / phiSafe stamp.
 */
export interface EventDefinition<TPayload extends Record<string, unknown>> {
  readonly name: string;
  readonly version: number;
  readonly fullName: string;
  readonly aggregateType: string;
  readonly schema: ZodObject;
  readonly aggregateIdFrom: (payload: TPayload) => string;
  readonly description: string;
  readonly owner: EventOwner;
  readonly retention: EventRetention;
  readonly phiSafe: boolean;
  readonly routingKey?: string;
}

/** Shape of a name segment — lowercase letters, digits, underscore. */
const NAME_SEGMENT = /^[a-z][a-z0-9_]*$/;

/** Full canonical event-name regex (`prefix.segment[.segment].v{n}`). */
export const EVENT_NAME_REGEX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v\d+$/;

function validateName(name: string, version: number): void {
  if (name.length === 0) {
    throw new Error("defineEvent: name must be non-empty.");
  }
  // Reject a name that already ends in `.vN` — the factory composes
  // the version suffix itself. Two sources of truth for the version
  // would let a typo produce `order.shipped.v1.v2`.
  if (/\.v\d+$/.test(name)) {
    throw new Error(
      `defineEvent: name "${name}" must not include the ".v{n}" suffix; pass version separately.`
    );
  }
  const segments = name.split(".");
  if (segments.length < 2) {
    throw new Error(
      `defineEvent: name "${name}" must contain at least one dotted segment (e.g. "order.shipped").`
    );
  }
  for (const segment of segments) {
    if (!NAME_SEGMENT.test(segment)) {
      throw new Error(
        `defineEvent: name "${name}" has invalid segment "${segment}"; segments must match ${NAME_SEGMENT.source}.`
      );
    }
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`defineEvent: version must be a positive integer, got ${version}.`);
  }
}

/**
 * Compile a declarative spec into a frozen `EventDefinition`.
 *
 * Throws synchronously if `name` or `version` is malformed, or if
 * `schema` is not a `ZodObject`. Both failures are programmer
 * errors and should surface at module load — long before a runtime
 * outbox dispatch could observe them.
 */
export function defineEvent<TSchema extends ZodObject>(
  spec: DefineEventSpec<TSchema>
): EventDefinition<z.infer<TSchema>> {
  validateName(spec.name, spec.version);

  // Defensive: we type `schema: TSchema extends ZodObject` so this
  // is structurally guaranteed at compile time, but a JS caller
  // could pass anything. `_def.typeName === "ZodObject"` is the
  // canonical Zod 4 introspection check.
  if (!isZodObject(spec.schema)) {
    throw new Error(
      `defineEvent: schema for "${spec.name}.v${spec.version}" must be a ZodObject (got ${
        getZodTypeName(spec.schema) ?? "unknown"
      }).`
    );
  }

  const fullName = `${spec.name}.v${spec.version}`;
  const aggregateIdFrom: (payload: z.infer<TSchema>) => string = spec.aggregateIdFrom;

  // Defaults documented on `DefineEventSpec`:
  //   - retention: "7y" — HIPAA-grade safe default.
  //   - phiSafe:   true — registry events are PHI-free unless
  //                       explicitly flagged otherwise (no current
  //                       event is PHI-bearing).
  //   - owner:     "system" — a deliberate red-flag default. Every
  //                           production definition SHOULD set its
  //                           own owner. Leaving it as "system"
  //                           shows up in the generated catalog
  //                           and signals an unmaintained event.
  const owner: EventOwner = spec.owner ?? "system";
  const retention: EventRetention = spec.retention ?? "7y";
  const phiSafe: boolean = spec.phiSafe ?? true;

  return Object.freeze({
    name: spec.name,
    version: spec.version,
    fullName,
    aggregateType: spec.aggregateType,
    schema: spec.schema,
    aggregateIdFrom,
    description: spec.description,
    owner,
    retention,
    phiSafe,
    ...(spec.routingKey !== undefined ? { routingKey: spec.routingKey } : {}),
  });
}

/**
 * Result of validating a payload against an event definition.
 *
 * `ok: false` returns `issues` in the same shape as
 * `ValidationError.issues` from `@pharmax/platform-core` so
 * call-site code (the bus, the emit helper, the parity guard) can
 * surface them through the same error type without an adapter.
 */
export type ValidationResult<TPayload extends Record<string, unknown>> =
  | { readonly ok: true; readonly value: TPayload }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<{
        readonly path: ReadonlyArray<string | number>;
        readonly message: string;
        readonly code?: string;
      }>;
    };

/**
 * Validate an unknown payload against a registered event definition.
 *
 * Returns the typed payload on success. On failure, returns a
 * structured issue list that mirrors `ValidationError.issues`. The
 * caller (the bus, the emit helper, the parity guard) decides what
 * to do with the failure — throw, log, or hand back to the user.
 */
export function validateAgainst<TPayload extends Record<string, unknown>>(
  definition: EventDefinition<TPayload>,
  payload: unknown
): ValidationResult<TPayload> {
  const parsed = definition.schema.safeParse(payload);
  if (parsed.success) {
    // ZodObject infers as a Record-shaped type; cast through unknown
    // is correct here because the definition's TPayload is the same
    // as the schema's inferred type by construction.
    return { ok: true, value: parsed.data as unknown as TPayload };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
      message: issue.message,
      ...(issue.code !== undefined ? { code: issue.code } : {}),
    })),
  };
}

// ---------------------------------------------------------------------
// Zod 4 introspection helpers
// ---------------------------------------------------------------------
//
// Zod 4's public introspection surface is `_def` plus the runtime
// constructor name. We keep the access patterns isolated to this
// file so a future Zod upgrade only needs one set of edits.

/** True when `t` is a `ZodObject` (the only payload shape we accept). */
export function isZodObject(t: ZodType | unknown): t is ZodObject {
  if (t === null || typeof t !== "object") return false;
  const typeName = getZodTypeName(t);
  return typeName === "ZodObject";
}

/** Returns the Zod runtime type name, or `undefined` if not a Zod type. */
export function getZodTypeName(t: unknown): string | undefined {
  if (t === null || typeof t !== "object") return undefined;
  const ctor = (t as { constructor?: { name?: string } }).constructor;
  if (ctor === undefined || typeof ctor.name !== "string") return undefined;
  if (!ctor.name.startsWith("Zod")) return undefined;
  return ctor.name;
}

/**
 * Returns true when the schema is `ZodOptional<...>` or otherwise
 * accepts `undefined`. Used by the compatibility checker to
 * classify a field as required vs. optional.
 */
export function isFieldOptional(schema: ZodType | unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  // Zod 4 exposes `isOptional()` on every `ZodType`. We feature-detect
  // before calling so a malformed schema gives a clean false rather
  // than a TypeError mid-introspection.
  const candidate = schema as { isOptional?: () => boolean };
  if (typeof candidate.isOptional === "function") {
    try {
      return candidate.isOptional() === true;
    } catch {
      return false;
    }
  }
  return false;
}
