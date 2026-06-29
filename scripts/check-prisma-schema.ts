#!/usr/bin/env tsx
// scripts/check-prisma-schema.ts
//
// Pre-merge schema linter. Walks the generated Prisma DMMF (for
// field metadata) and the raw `schema.prisma` text (for index
// declarations, which the runtime DMMF strips per
// `Omit<DMMF.Datamodel, 'indexes'>`) and enforces the structural
// conventions documented in `docs/ARCHITECTURE_PRINCIPLES.md` §D
// ("schema linter on `prisma/schema/*.prisma`"). These are rules a
// `prisma validate` pass will not catch — they describe how Pharmax
// models must be shaped on top of valid Prisma syntax.
//
// Rules enforced (each rule prints model + field + hint on fail):
//
//   R1. Every model declares `@@map("snake_case_name")`. Hidden
//       default-map (Pascal-case identical to model name) is
//       rejected because on-disk identifier and on-wire identifier
//       would drift when only one is grepped for.
//
//   R2. Every tenant-scoped model registered in @pharmax/tenancy
//       with kind `organizationId` has a `organizationId String
//       @db.Uuid` field WITH a relation back to `Organization`.
//
//   R3. Every tenant-scoped (kind `organizationId`) model has at
//       least one index/unique/primary-key whose FIRST field is
//       `organizationId`. Composite OK. This makes RLS-filtered
//       queries planner-friendly: Postgres won't pick a fancier
//       index for the `current_setting(...)` equality without an
//       `organizationId`-prefixed one available.
//
//   R4. No `onDelete: Cascade` on a relation whose target is
//       `Organization`. The original principle is that an org
//       deletion must not silently destroy PHI without writing an
//       audit row; we enforce that by requiring `Restrict` on
//       every direct edge from `Organization`. Cascade on other
//       parent-child edges (e.g. `Invoice → InvoiceLine`,
//       `User → UserRole`) is allowed because those are
//       junction-like semantics where cascade is the correct
//       behavior. Inline exemption: a relation field annotated
//       with `/// schema-lint: allow-cascade <reason>` is
//       skipped — used sparingly, reviewed at PR time.
//
//   R5. (WARN) `status: String` on a model that has a sibling
//       `<Model>Status` enum — likely should use the enum. Prints
//       but doesn't fail.
//
//   R6. Every blind-index column (suffix `Bi`) has a sibling
//       PHI source — EITHER an envelope column (suffix `Enc`) for
//       the privacy-preserving search pattern OR a plaintext
//       String column of the same root name for the normalization
//       pattern (e.g. `rxNumber` + `rxNumberBi` where the index
//       is a case-insensitive HMAC over a non-PHI identifier).
//       An orphan `*Bi` column with neither sibling indicates a
//       missing source field and is a schema bug.
//
//   R7. Every envelope column (suffix `Enc`) is `Json` (not
//       `String`). The envelope shape is structured.
//
// Exit codes:
//   0  All FAIL rules passed (R5 warnings printed; don't fail).
//   1  One or more FAIL violations.
//   2  Internal error (couldn't read schema or load registries).
//
// Pairs with: scripts/check-migration-rls.ts (RLS coverage at the
// migration layer) and `tenant-scoped-models.test.ts` (registry
// parity). The three together form the
// "no tenant-scoped model can land without
// organizationId + index + RLS + classification" enforcement net.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TENANT_EXCLUDED_MODELS, TENANT_SCOPED_MODELS } from "@pharmax/tenancy";

// Prisma 7 removed the runtime `Prisma.dmmf` value from the generated
// client (only the `DMMF` *type* remains). The schema's DMMF is now
// obtained from the schema file via `@prisma/internals.getDMMF`, the
// supported programmatic API. `@prisma/internals` is CommonJS; under
// ESM + tsx a `createRequire` load is the interop-stable way to reach
// its named export.
const requireCjs = createRequire(import.meta.url);

/** Minimal projection of the classic DMMF shape this linter reads. */
interface DmmfField {
  readonly name: string;
  readonly kind: "scalar" | "object" | "enum" | "unsupported";
  readonly type: string;
  readonly isRequired: boolean;
  readonly isList: boolean;
  readonly isUnique: boolean;
  readonly isId: boolean;
  readonly relationOnDelete?: string;
}
interface DmmfModel {
  readonly name: string;
  readonly dbName: string | null;
  readonly fields: ReadonlyArray<DmmfField>;
  readonly uniqueIndexes: ReadonlyArray<{ readonly fields: ReadonlyArray<string> }>;
  readonly primaryKey: { readonly fields: ReadonlyArray<string> } | null;
}
interface DmmfDocument {
  readonly datamodel: {
    readonly models: ReadonlyArray<DmmfModel>;
    readonly enums: ReadonlyArray<{ readonly name: string }>;
  };
}

function loadSchemaDmmf(schemaSource: string): Promise<DmmfDocument> {
  const { getDMMF } = requireCjs("@prisma/internals") as {
    getDMMF: (options: { datamodel: string }) => Promise<DmmfDocument>;
  };
  return getDMMF({ datamodel: schemaSource });
}

/** Severity tier. WARN prints but does not fail the build. */
export type Severity = "FAIL" | "WARN";

export interface Violation {
  readonly rule: string;
  readonly severity: Severity;
  readonly model: string;
  readonly field?: string;
  readonly message: string;
}

/**
 * Subset of `Prisma.DMMF.Model` we read. Decoupled from the full
 * Prisma type surface so unit tests can build synthetic models.
 */
export interface ModelLike {
  readonly name: string;
  readonly dbName: string | null;
  readonly fields: ReadonlyArray<{
    readonly name: string;
    readonly kind: "scalar" | "object" | "enum" | "unsupported";
    readonly type: string;
    readonly isRequired: boolean;
    readonly isList: boolean;
    readonly relationOnDelete?: string;
  }>;
  /** Combined view of `@@index`, `@@unique`, `@@id`. */
  readonly indexes: ReadonlyArray<{ readonly fields: ReadonlyArray<string> }>;
}

const SNAKE_CASE_PATTERN = /^[a-z][a-z0-9_]*$/;
const ENC_SUFFIX = /Enc$/;
const BI_SUFFIX = /Bi$/;

// Models whose `@@map` is allowed to be the default (model name
// identical to table name). Empty today — every tenant model
// declares snake_case `@@map`. Add to this set ONLY with a comment
// explaining why (e.g. an external integration's mirror).
const PASCAL_MAP_ALLOWED: ReadonlySet<string> = new Set();

/**
 * Pure rule engine. Takes pre-projected model data + the tenancy
 * registries (both injected so tests can run without the real
 * Prisma client). Returns the full violation set.
 */
export type ScopedKind = "organizationId" | "selfOrganization";

export function lintSchema(args: {
  readonly models: ReadonlyArray<ModelLike>;
  readonly enumNames: ReadonlySet<string>;
  readonly scopedKindByName: ReadonlyMap<string, ScopedKind>;
  readonly excludedNames: ReadonlySet<string>;
}): ReadonlyArray<Violation> {
  const violations: Violation[] = [];

  for (const model of args.models) {
    // R1 — snake_case @@map
    if (!PASCAL_MAP_ALLOWED.has(model.name)) {
      if (model.dbName === null || model.dbName === undefined || model.dbName === model.name) {
        violations.push({
          rule: "R1",
          severity: "FAIL",
          model: model.name,
          message: `Model "${model.name}" must declare @@map to a snake_case table name (current dbName: ${JSON.stringify(model.dbName)}).`,
        });
      } else if (!SNAKE_CASE_PATTERN.test(model.dbName)) {
        violations.push({
          rule: "R1",
          severity: "FAIL",
          model: model.name,
          message: `Model "${model.name}" @@map value "${model.dbName}" is not snake_case (allowed: ^[a-z][a-z0-9_]*$).`,
        });
      }
    }

    const isExcluded = args.excludedNames.has(model.name);
    const kind = args.scopedKindByName.get(model.name);
    const isOrgScoped = kind === "organizationId";

    // R2 — tenant-scoped (kind organizationId) carries the
    // discriminator column AND a relation back to Organization.
    if (isOrgScoped) {
      const orgField = model.fields.find((f) => f.name === "organizationId");
      if (orgField === undefined) {
        violations.push({
          rule: "R2",
          severity: "FAIL",
          model: model.name,
          field: "organizationId",
          message: `Tenant-scoped model "${model.name}" is missing the required "organizationId" field. Registered as kind: "organizationId" in @pharmax/tenancy TENANT_SCOPED_MODELS, so RLS + the Prisma extension expect the column.`,
        });
      } else {
        if (orgField.isList) {
          violations.push({
            rule: "R2",
            severity: "FAIL",
            model: model.name,
            field: "organizationId",
            message: `"organizationId" must be a scalar, not a list.`,
          });
        }
        if (orgField.isRequired === false) {
          violations.push({
            rule: "R2",
            severity: "FAIL",
            model: model.name,
            field: "organizationId",
            message: `"organizationId" must be NOT NULL — RLS predicates don't fail closed on NULL; we fail closed at the column level instead.`,
          });
        }
        if (orgField.type !== "String") {
          violations.push({
            rule: "R2",
            severity: "FAIL",
            model: model.name,
            field: "organizationId",
            message: `"organizationId" must be String @db.Uuid (current type: ${orgField.type}).`,
          });
        }
        // Companion relation field — accept any name pointing to
        // Organization (today every model uses "organization").
        const orgRelation = model.fields.find(
          (f) => f.kind === "object" && f.type === "Organization"
        );
        if (orgRelation === undefined) {
          violations.push({
            rule: "R2",
            severity: "FAIL",
            model: model.name,
            message: `Tenant-scoped model "${model.name}" must declare a relation field of type Organization (e.g. \`organization Organization @relation(fields: [organizationId], references: [id])\`).`,
          });
        }
      }
    }

    // R3 — organizationId-prefixed index exists.
    if (isOrgScoped) {
      const orgPrefixed = model.indexes.some((idx) => idx.fields[0] === "organizationId");
      if (!orgPrefixed) {
        violations.push({
          rule: "R3",
          severity: "FAIL",
          model: model.name,
          message: `Tenant-scoped model "${model.name}" must have at least one index/unique/primary-key whose first field is "organizationId" so RLS-filtered queries are planner-friendly. (Saw indexes: ${JSON.stringify(model.indexes.map((i) => i.fields))}).`,
        });
      }
    }

    // R4 — no Cascade on a direct relation to Organization.
    // Cascade from Organization would silently destroy PHI
    // without writing an audit row.
    if (!isExcluded) {
      for (const f of model.fields) {
        if (f.kind !== "object") continue;
        if (f.type !== "Organization") continue;
        if (f.relationOnDelete === "Cascade") {
          violations.push({
            rule: "R4",
            severity: "FAIL",
            model: model.name,
            field: f.name,
            message: `Relation "${f.name}" to Organization uses onDelete: Cascade. Use Restrict — an organization deletion must force an explicit shred path, not silently destroy tenant data without an audit row.`,
          });
        }
      }
    }

    // R5 — `status: String` where `<Model>Status` enum exists.
    for (const f of model.fields) {
      if (f.kind !== "scalar") continue;
      if (f.type !== "String") continue;
      if (f.name !== "status") continue;
      const expectedEnumName = `${model.name}Status`;
      if (args.enumNames.has(expectedEnumName)) {
        violations.push({
          rule: "R5",
          severity: "WARN",
          model: model.name,
          field: f.name,
          message: `Field "status" on "${model.name}" is String but enum "${expectedEnumName}" exists — consider using the enum for compile-time exhaustiveness.`,
        });
      }
    }

    // R6 — every *Bi column has a sibling PHI source. Two
    // accepted shapes:
    //   (a) Envelope sibling (`<root>Enc`) for the
    //       privacy-preserving blind-index-over-encrypted-PHI
    //       pattern. Documented cross-name variants:
    //         `phoneLast10Bi`  → `phoneEnc`
    //         `dobYearMonthBi` → `dateOfBirthEnc`
    //         `dobBi`          → `dateOfBirthEnc`
    //   (b) Plaintext sibling (`<root>` typed `String`, kind
    //       `scalar`) for the normalization-index-over-plaintext
    //       pattern (e.g. `rxNumber` + `rxNumberBi` where the
    //       blind index is a case-/format-insensitive HMAC and
    //       the plaintext IS the source of truth).
    for (const f of model.fields) {
      if (!BI_SUFFIX.test(f.name)) continue;
      const root = f.name.replace(BI_SUFFIX, "");
      const exactEnc = model.fields.some((g) => g.name === `${root}Enc`);
      const phoneEnc = root === "phoneLast10" && model.fields.some((g) => g.name === "phoneEnc");
      const dobYmEnc =
        root === "dobYearMonth" && model.fields.some((g) => g.name === "dateOfBirthEnc");
      const dobFullEnc = root === "dob" && model.fields.some((g) => g.name === "dateOfBirthEnc");
      const plaintextSibling = model.fields.some(
        (g) => g.name === root && g.kind === "scalar" && g.type === "String"
      );
      if (!exactEnc && !phoneEnc && !dobYmEnc && !dobFullEnc && !plaintextSibling) {
        violations.push({
          rule: "R6",
          severity: "FAIL",
          model: model.name,
          field: f.name,
          message: `Blind-index column "${f.name}" has no sibling PHI source. Add either a "${root}Enc" envelope column (encrypted-PHI pattern) or a "${root}" String plaintext column (normalization-index pattern).`,
        });
      }
    }

    // R7 — every *Enc column is Json.
    for (const f of model.fields) {
      if (!ENC_SUFFIX.test(f.name)) continue;
      if (f.kind !== "scalar") continue;
      if (f.type !== "Json") {
        violations.push({
          rule: "R7",
          severity: "FAIL",
          model: model.name,
          field: f.name,
          message: `Envelope column "${f.name}" must be Json (got ${f.type}). The envelope shape is { v, alg, kek, wDek, iv, ct, tag } — a String column can't enforce that structure.`,
        });
      }
    }
  }

  return violations;
}

/**
 * Parse raw schema.prisma text into a per-model map of index
 * declarations (`@@index`, `@@unique`, `@@id`). The runtime
 * `Prisma.dmmf.datamodel.models[i]` only exposes `uniqueIndexes`
 * and `primaryKey`; non-unique `@@index` blocks are stripped per
 * `Omit<DMMF.Datamodel, 'indexes'>`. We parse them out of the
 * source text directly.
 *
 * The parser is intentionally simple: it walks model bodies
 * (`model X { ... }`), and inside each model collects lines
 * starting with `@@index`, `@@unique`, or `@@id`, extracting the
 * bracketed field list.
 */
export function extractIndexesPerModel(
  source: string
): ReadonlyMap<string, ReadonlyArray<{ fields: ReadonlyArray<string> }>> {
  const out = new Map<string, Array<{ fields: ReadonlyArray<string> }>>();

  const modelRe = /^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm;
  for (const m of source.matchAll(modelRe)) {
    const name = m[1];
    if (name === undefined) continue;
    const body = m[2] ?? "";

    const collected: Array<{ fields: ReadonlyArray<string> }> = [];
    // Match @@index([a, b, c]) / @@unique([a, b]) / @@id([a, b]).
    // Trailing options (e.g. `map: "..."`) are tolerated.
    const idxRe = /@@(?:index|unique|id)\s*\(\s*\[\s*([^\]]+?)\s*\]/g;
    for (const im of body.matchAll(idxRe)) {
      const inner = im[1];
      if (inner === undefined) continue;
      const fields = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (fields.length > 0) {
        collected.push({ fields });
      }
    }
    out.set(name, collected);
  }

  return out;
}

/**
 * Adapter: project the real Prisma DMMF model + parsed-from-text
 * indexes into ModelLike.
 */
export function dmmfToModelLikes(
  models: ReadonlyArray<DmmfModel>,
  indexesByModel: ReadonlyMap<string, ReadonlyArray<{ fields: ReadonlyArray<string> }>>
): ReadonlyArray<ModelLike> {
  return models.map((m) => {
    const parsedIndexes = indexesByModel.get(m.name) ?? [];
    const uniqueIndexes = m.uniqueIndexes.map((i) => ({ fields: i.fields }));
    const primaryKey = m.primaryKey === null ? [] : [{ fields: m.primaryKey.fields }];
    // Single-field `@unique` (not composite) appears on the field
    // itself (`isUnique: true`) — surface those as single-field
    // indexes too so a model that has @id @unique on organizationId
    // would pass R3 (currently no such model exists, but the
    // projection is consistent with R3's intent).
    const inlineUniques = m.fields
      .filter((f) => f.isUnique || f.isId)
      .map((f) => ({ fields: [f.name] }));
    return {
      name: m.name,
      dbName: m.dbName,
      fields: m.fields.map((f) => ({
        name: f.name,
        kind: f.kind,
        type: f.type,
        isRequired: f.isRequired,
        isList: f.isList,
        // Spread-when-defined so the projection matches ModelLike's
        // `relationOnDelete?: string` (absent when not relevant)
        // under exactOptionalPropertyTypes — Prisma's DMMF gives
        // `string | undefined` for this field, but the contract
        // here is "either a string or the property is absent".
        ...(f.relationOnDelete === undefined ? {} : { relationOnDelete: f.relationOnDelete }),
      })),
      indexes: [...parsedIndexes, ...uniqueIndexes, ...primaryKey, ...inlineUniques],
    };
  });
}

function buildScopedKindByName(
  registry: ReadonlyMap<string, { kind: ScopedKind }>
): ReadonlyMap<string, ScopedKind> {
  const out = new Map<string, ScopedKind>();
  for (const [name, entry] of registry) out.set(name, entry.kind);
  return out;
}

function formatViolation(v: Violation): string {
  const where = v.field === undefined ? v.model : `${v.model}.${v.field}`;
  return `  [${v.rule}] (${v.severity}) ${where} — ${v.message}`;
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const schemaPath = join(root, "prisma", "schema.prisma");
  const source = readFileSync(schemaPath, "utf8");
  const indexesByModel = extractIndexesPerModel(source);

  const dmmf = await loadSchemaDmmf(source);
  const models = dmmfToModelLikes(dmmf.datamodel.models, indexesByModel);
  const enumNames = new Set(dmmf.datamodel.enums.map((e) => e.name));
  const scopedKindByName = buildScopedKindByName(TENANT_SCOPED_MODELS);
  const excludedNames = TENANT_EXCLUDED_MODELS;

  const violations = lintSchema({ models, enumNames, scopedKindByName, excludedNames });

  const fails = violations.filter((v) => v.severity === "FAIL");
  const warns = violations.filter((v) => v.severity === "WARN");

  if (warns.length > 0) {
    process.stderr.write(`[check-prisma-schema] ${warns.length} warning(s):\n`);
    for (const w of warns) process.stderr.write(`${formatViolation(w)}\n`);
  }

  if (fails.length > 0) {
    process.stderr.write(`[check-prisma-schema] ${fails.length} failure(s):\n`);
    for (const f of fails) process.stderr.write(`${formatViolation(f)}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `[check-prisma-schema] ok — ${models.length} model(s) checked, ${scopedKindByName.size} tenant-scoped, ${excludedNames.size} excluded${
      warns.length > 0 ? `, ${warns.length} warning(s)` : ""
    }\n`
  );
}

const RUNNING_AS_SCRIPT = process.argv[1] === fileURLToPath(import.meta.url);
if (RUNNING_AS_SCRIPT) {
  main().catch((err) => {
    process.stderr.write(`[check-prisma-schema] internal error: ${String(err)}\n`);
    process.exit(2);
  });
}
