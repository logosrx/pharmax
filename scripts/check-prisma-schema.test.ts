// Unit tests for the schema linter rule engine.
//
// Tests are constructed against synthetic `ModelLike` objects so
// no real Prisma client or schema file is needed. This pins each
// rule's pass/fail semantics independently.

import { describe, expect, it } from "vitest";

import {
  dmmfToModelLikes,
  extractIndexesPerModel,
  lintSchema,
  type ModelLike,
  type ScopedKind,
} from "./check-prisma-schema.js";

const NO_ENUMS = new Set<string>();
const NO_EXCLUDED = new Set<string>();
const NO_SCOPED = new Map<string, ScopedKind>();

function fieldId(): ModelLike["fields"][number] {
  return {
    name: "id",
    kind: "scalar",
    type: "String",
    isRequired: true,
    isList: false,
  };
}

function fieldOrganizationId(): ModelLike["fields"][number] {
  return {
    name: "organizationId",
    kind: "scalar",
    type: "String",
    isRequired: true,
    isList: false,
  };
}

function fieldOrganizationRelation(): ModelLike["fields"][number] {
  return {
    name: "organization",
    kind: "object",
    type: "Organization",
    isRequired: true,
    isList: false,
  };
}

function model(name: string, overrides: Partial<ModelLike> = {}): ModelLike {
  return {
    name,
    dbName: name.toLowerCase(),
    fields: [fieldId(), fieldOrganizationId(), fieldOrganizationRelation()],
    indexes: [{ fields: ["organizationId"] }],
    ...overrides,
  };
}

describe("R1 — snake_case @@map", () => {
  it("passes when dbName is snake_case and != model name", () => {
    const out = lintSchema({
      models: [model("Patient", { dbName: "patient" })],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R1")).toEqual([]);
  });

  it("fails when dbName equals model name (no @@map present)", () => {
    const out = lintSchema({
      models: [model("Patient", { dbName: "Patient" })],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    const r1 = out.filter((v) => v.rule === "R1");
    expect(r1.length).toBe(1);
    expect(r1[0]?.severity).toBe("FAIL");
  });

  it("fails when dbName is null", () => {
    const out = lintSchema({
      models: [model("Patient", { dbName: null })],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R1").length).toBe(1);
  });

  it("fails when dbName contains uppercase or hyphen", () => {
    const out = lintSchema({
      models: [
        model("Patient", { dbName: "Patient_v2" }),
        model("Provider", { dbName: "provider-v2" }),
      ],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R1").length).toBe(2);
  });
});

describe("R2 — tenant-scoped models carry organizationId + relation", () => {
  const scoped = new Map<string, ScopedKind>([["Patient", "organizationId"]]);

  it("passes for a properly shaped tenant-scoped model", () => {
    const out = lintSchema({
      models: [model("Patient")],
      enumNames: NO_ENUMS,
      scopedKindByName: scoped,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R2")).toEqual([]);
  });

  it("fails when organizationId field is missing", () => {
    const m = model("Patient", { fields: [fieldId()] });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: scoped,
      excludedNames: NO_EXCLUDED,
    });
    const r2 = out.filter((v) => v.rule === "R2");
    expect(r2.length).toBeGreaterThanOrEqual(1);
    expect(r2[0]?.message).toMatch(/missing the required "organizationId"/);
  });

  it("fails when organizationId is nullable (isRequired: false)", () => {
    const m = model("Patient", {
      fields: [
        fieldId(),
        { ...fieldOrganizationId(), isRequired: false },
        fieldOrganizationRelation(),
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: scoped,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R2").some((v) => v.message.includes("NOT NULL"))).toBe(
      true
    );
  });

  it("fails when organizationId type is not String", () => {
    const m = model("Patient", {
      fields: [fieldId(), { ...fieldOrganizationId(), type: "Int" }, fieldOrganizationRelation()],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: scoped,
      excludedNames: NO_EXCLUDED,
    });
    expect(
      out.filter((v) => v.rule === "R2").some((v) => v.message.includes("String @db.Uuid"))
    ).toBe(true);
  });

  it("fails when Organization relation field is missing", () => {
    const m = model("Patient", { fields: [fieldId(), fieldOrganizationId()] });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: scoped,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R2").some((v) => v.message.includes("Organization"))).toBe(
      true
    );
  });

  it("skips R2 entirely for kind=selfOrganization (Organization model)", () => {
    const m: ModelLike = {
      name: "Organization",
      dbName: "organization",
      fields: [fieldId()],
      indexes: [],
    };
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: new Map<string, ScopedKind>([["Organization", "selfOrganization"]]),
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R2")).toEqual([]);
    expect(out.filter((v) => v.rule === "R3")).toEqual([]);
  });

  it("skips R2 for untracked models (regression: no false-positive on non-tenant tables)", () => {
    const out = lintSchema({
      models: [model("Permission", { fields: [fieldId()] })],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: new Set(["Permission"]),
    });
    expect(out.filter((v) => v.rule === "R2")).toEqual([]);
  });
});

describe("R3 — organizationId-prefixed index", () => {
  const scoped = new Map<string, ScopedKind>([["Patient", "organizationId"]]);

  it("passes with a single-field index on organizationId", () => {
    const out = lintSchema({
      models: [model("Patient", { indexes: [{ fields: ["organizationId"] }] })],
      enumNames: NO_ENUMS,
      scopedKindByName: scoped,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R3")).toEqual([]);
  });

  it("passes with a composite index where organizationId is FIRST", () => {
    const out = lintSchema({
      models: [model("Patient", { indexes: [{ fields: ["organizationId", "lastNameBi"] }] })],
      enumNames: NO_ENUMS,
      scopedKindByName: scoped,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R3")).toEqual([]);
  });

  it("fails with NO indexes", () => {
    const out = lintSchema({
      models: [model("Patient", { indexes: [] })],
      enumNames: NO_ENUMS,
      scopedKindByName: scoped,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R3").length).toBe(1);
  });

  it("fails with indexes that don't START with organizationId", () => {
    const out = lintSchema({
      models: [model("Patient", { indexes: [{ fields: ["lastNameBi", "organizationId"] }] })],
      enumNames: NO_ENUMS,
      scopedKindByName: scoped,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R3").length).toBe(1);
  });
});

describe("R4 — no Cascade on a relation to Organization", () => {
  it("passes for Restrict on the Organization relation", () => {
    const m = model("Patient", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        { ...fieldOrganizationRelation(), relationOnDelete: "Restrict" },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R4")).toEqual([]);
  });

  it("allows Cascade on a relation to a NON-Organization parent (e.g. Invoice → InvoiceLine)", () => {
    const m = model("InvoiceLine", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        fieldOrganizationRelation(),
        {
          name: "invoice",
          kind: "object",
          type: "Invoice",
          isRequired: true,
          isList: false,
          relationOnDelete: "Cascade",
        },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R4")).toEqual([]);
  });

  it("fails for Cascade on a relation to Organization", () => {
    const m = model("IdempotencyKey", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        { ...fieldOrganizationRelation(), relationOnDelete: "Cascade" },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R4").length).toBe(1);
  });

  it("skips R4 for excluded models entirely (Cascade allowed on junction tables)", () => {
    const m = model("ClinicSite", {
      fields: [
        fieldId(),
        {
          name: "organization",
          kind: "object",
          type: "Organization",
          isRequired: true,
          isList: false,
          relationOnDelete: "Cascade",
        },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: new Set(["ClinicSite"]),
    });
    expect(out.filter((v) => v.rule === "R4")).toEqual([]);
  });
});

describe("R5 — status: String with sibling enum (WARN)", () => {
  it("warns when status is String and <Model>Status enum exists", () => {
    const m = model("Patient", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        fieldOrganizationRelation(),
        {
          name: "status",
          kind: "scalar",
          type: "String",
          isRequired: true,
          isList: false,
        },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: new Set(["PatientStatus"]),
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    const r5 = out.filter((v) => v.rule === "R5");
    expect(r5.length).toBe(1);
    expect(r5[0]?.severity).toBe("WARN");
  });

  it("does not warn when status is already an enum (kind: enum)", () => {
    const m = model("Patient", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        fieldOrganizationRelation(),
        {
          name: "status",
          kind: "enum",
          type: "PatientStatus",
          isRequired: true,
          isList: false,
        },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: new Set(["PatientStatus"]),
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R5")).toEqual([]);
  });

  it("does not warn when no sibling enum exists", () => {
    const m = model("Patient", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        fieldOrganizationRelation(),
        {
          name: "status",
          kind: "scalar",
          type: "String",
          isRequired: true,
          isList: false,
        },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R5")).toEqual([]);
  });
});

describe("R6 — blind-index columns paired with envelope columns", () => {
  it("passes for an exact-name pair (lastNameBi ↔ lastNameEnc)", () => {
    const m = model("Patient", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        fieldOrganizationRelation(),
        { name: "lastNameEnc", kind: "scalar", type: "Json", isRequired: false, isList: false },
        { name: "lastNameBi", kind: "scalar", type: "String", isRequired: false, isList: false },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R6")).toEqual([]);
  });

  it("passes for the documented derived pairs (phoneLast10Bi ↔ phoneEnc, dobYearMonthBi ↔ dateOfBirthEnc)", () => {
    const m = model("Patient", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        fieldOrganizationRelation(),
        { name: "phoneEnc", kind: "scalar", type: "Json", isRequired: false, isList: false },
        { name: "phoneLast10Bi", kind: "scalar", type: "String", isRequired: false, isList: false },
        { name: "dateOfBirthEnc", kind: "scalar", type: "Json", isRequired: false, isList: false },
        {
          name: "dobYearMonthBi",
          kind: "scalar",
          type: "String",
          isRequired: false,
          isList: false,
        },
        { name: "dobBi", kind: "scalar", type: "String", isRequired: false, isList: false },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R6")).toEqual([]);
  });

  it("passes for the normalization-index pattern (plaintext String sibling)", () => {
    const m = model("Prescription", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        fieldOrganizationRelation(),
        { name: "rxNumber", kind: "scalar", type: "String", isRequired: true, isList: false },
        { name: "rxNumberBi", kind: "scalar", type: "String", isRequired: true, isList: false },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R6")).toEqual([]);
  });

  it("fails for an orphan *Bi column with no sibling (encrypted OR plaintext)", () => {
    const m = model("Patient", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        fieldOrganizationRelation(),
        { name: "mrnBi", kind: "scalar", type: "String", isRequired: false, isList: false },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R6").length).toBe(1);
  });
});

describe("R7 — envelope columns are Json", () => {
  it("passes for Json typed *Enc columns", () => {
    const m = model("Patient", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        fieldOrganizationRelation(),
        { name: "ssnLast4Enc", kind: "scalar", type: "Json", isRequired: false, isList: false },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R7")).toEqual([]);
  });

  it("fails for String typed *Enc columns", () => {
    const m = model("Patient", {
      fields: [
        fieldId(),
        fieldOrganizationId(),
        fieldOrganizationRelation(),
        { name: "ssnLast4Enc", kind: "scalar", type: "String", isRequired: false, isList: false },
      ],
    });
    const out = lintSchema({
      models: [m],
      enumNames: NO_ENUMS,
      scopedKindByName: NO_SCOPED,
      excludedNames: NO_EXCLUDED,
    });
    expect(out.filter((v) => v.rule === "R7").length).toBe(1);
  });
});

describe("extractIndexesPerModel", () => {
  it("extracts @@index, @@unique, and @@id blocks per model", () => {
    const source = `
model A {
  id String @id
  organizationId String

  @@index([organizationId, status])
  @@unique([organizationId, code])
  @@map("a")
}

model B {
  organizationId String
  code String

  @@id([organizationId, code])
  @@map("b")
}
`;
    const out = extractIndexesPerModel(source);
    expect(out.get("A")?.map((i) => i.fields)).toEqual([
      ["organizationId", "status"],
      ["organizationId", "code"],
    ]);
    expect(out.get("B")?.map((i) => i.fields)).toEqual([["organizationId", "code"]]);
  });

  it("tolerates trailing options on @@index blocks", () => {
    const source = `
model A {
  id String @id

  @@index([organizationId], map: "ix_a_org", type: BTree)
  @@map("a")
}
`;
    const out = extractIndexesPerModel(source);
    expect(out.get("A")?.[0]?.fields).toEqual(["organizationId"]);
  });

  it("returns empty array for models with no @@index/@@unique/@@id", () => {
    const source = `
model A {
  id String @id
  @@map("a")
}
`;
    const out = extractIndexesPerModel(source);
    expect(out.get("A")).toEqual([]);
  });
});

describe("dmmfToModelLikes — adapter projects the real DMMF shape", () => {
  it("merges parsed @@index entries with uniqueIndexes and primary keys", () => {
    const dmmfModels = [
      {
        name: "Patient",
        dbName: "patient",
        fields: [
          {
            name: "id",
            kind: "scalar",
            type: "String",
            isRequired: true,
            isList: false,
            isUnique: false,
            isId: true,
          },
        ],
        uniqueIndexes: [{ name: null, fields: ["organizationId", "mrnBi"] }],
        uniqueFields: [],
        primaryKey: { name: null, fields: ["id"] },
      },
    ];
    const indexes = new Map<string, Array<{ fields: ReadonlyArray<string> }>>([
      ["Patient", [{ fields: ["organizationId", "lastNameBi"] }]],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = dmmfToModelLikes(dmmfModels as any, indexes);
    expect(out[0]?.indexes.map((i) => i.fields)).toEqual([
      ["organizationId", "lastNameBi"],
      ["organizationId", "mrnBi"],
      ["id"],
      ["id"],
    ]);
  });
});
