// scripts/check-kms-inventory.test.ts
//
// Covers each pure function exported from check-kms-inventory.ts plus
// the end-to-end comparator. Test inputs are inline synthetic HCL /
// markdown — no filesystem access — so the suite runs anywhere and
// pins the parser's behaviour against deliberately edge-case inputs.

import { describe, expect, it } from "vitest";

import {
  compareKmsState,
  extractAliasSuffixes,
  extractResourceBlocks,
  extractVariableDefault,
  findMatchingCloseBrace,
  formatDriftReport,
  isRotationYes,
  parseInventorySummaryTable,
  parseKmsAliasResources,
  parseKmsKeyBody,
  parseKmsKeyResources,
  resolveKeySpec,
  splitMarkdownRow,
} from "./check-kms-inventory.js";

describe("findMatchingCloseBrace", () => {
  it("pairs a flat brace pair", () => {
    const s = "{ hello }";
    expect(findMatchingCloseBrace(s, 0)).toBe(s.length - 1);
  });

  it("pairs nested braces", () => {
    const s = "{ outer { inner } end }";
    expect(findMatchingCloseBrace(s, 0)).toBe(s.length - 1);
  });

  it("ignores `}` inside a `# ...` line comment", () => {
    const s = "{ # } not a real close brace\n }";
    expect(findMatchingCloseBrace(s, 0)).toBe(s.length - 1);
  });

  it("ignores `}` inside a `// ...` line comment", () => {
    const s = "{ // } not a real close brace\n }";
    expect(findMatchingCloseBrace(s, 0)).toBe(s.length - 1);
  });

  it("ignores `}` inside a /* ... */ block comment", () => {
    const s = "{ /* } */ }";
    expect(findMatchingCloseBrace(s, 0)).toBe(s.length - 1);
  });

  it("returns -1 when no matching close brace exists", () => {
    expect(findMatchingCloseBrace("{ { unbalanced", 0)).toBe(-1);
  });

  it("throws if the start position is not a `{`", () => {
    expect(() => findMatchingCloseBrace("hello", 0)).toThrow(/expected '\{'/);
  });
});

describe("extractResourceBlocks", () => {
  it("captures one block per matching resource header", () => {
    const hcl = `
resource "aws_kms_key" "alpha" {
  description = "alpha"
}

resource "aws_kms_key" "beta" {
  description = "beta"
  tags = {
    Foo = "bar"
  }
}

resource "aws_other" "ignored" {
  description = "not us"
}
`;
    const blocks = extractResourceBlocks(hcl, "aws_kms_key");
    expect(blocks.map((b) => b.name)).toEqual(["alpha", "beta"]);
    expect(blocks[1]?.body).toContain('Foo = "bar"');
    expect(blocks[1]?.body).not.toContain("aws_other");
  });

  it("returns [] when no matching resource exists", () => {
    expect(extractResourceBlocks(`resource "aws_other" "x" {}`, "aws_kms_key")).toEqual([]);
  });

  it("ignores nested block braces inside the resource body", () => {
    const hcl = `
resource "aws_kms_key" "with_nested" {
  description = "x"
  tags = {
    A = "1"
    B = "2"
  }
  lifecycle {
    create_before_destroy = true
  }
}
`;
    const blocks = extractResourceBlocks(hcl, "aws_kms_key");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.body).toContain("create_before_destroy");
  });
});

describe("parseKmsKeyBody — defaults and overrides", () => {
  it("applies the AWS defaults when fields are absent", () => {
    expect(parseKmsKeyBody(`description = "plain symmetric key"`)).toEqual({
      keyUsage: "ENCRYPT_DECRYPT",
      keySpec: "SYMMETRIC_DEFAULT",
      enableKeyRotation: false,
    });
  });

  it("captures an explicit key_usage", () => {
    const body = `
      key_usage = "GENERATE_VERIFY_MAC"
      customer_master_key_spec = "HMAC_256"
      enable_key_rotation = true
    `;
    expect(parseKmsKeyBody(body)).toEqual({
      keyUsage: "GENERATE_VERIFY_MAC",
      keySpec: "HMAC_256",
      enableKeyRotation: true,
    });
  });

  it("captures a variable-reference key_spec without resolving it", () => {
    const body = `
      key_usage = "SIGN_VERIFY"
      customer_master_key_spec = var.asymm_sign_key_spec
    `;
    const out = parseKmsKeyBody(body);
    expect(out.keyUsage).toBe("SIGN_VERIFY");
    expect(out.keySpec).toEqual({ varRef: "asymm_sign_key_spec" });
    expect(out.enableKeyRotation).toBe(false);
  });
});

describe("parseKmsKeyResources — end-to-end", () => {
  it("pulls every aws_kms_key resource out of a multi-resource module", () => {
    const hcl = `
resource "aws_kms_key" "rds" {
  description = "rds"
  enable_key_rotation = true
}

resource "aws_kms_alias" "rds" {
  name = "alias/$\{var.name_prefix}-rds"
  target_key_id = aws_kms_key.rds.id
}

resource "aws_kms_key" "search" {
  description = "search"
  key_usage = "GENERATE_VERIFY_MAC"
  customer_master_key_spec = "HMAC_256"
  enable_key_rotation = true
}
`;
    const keys = parseKmsKeyResources(hcl);
    expect(keys.map((k) => k.name)).toEqual(["rds", "search"]);
    expect(keys[0]).toEqual({
      name: "rds",
      keyUsage: "ENCRYPT_DECRYPT",
      keySpec: "SYMMETRIC_DEFAULT",
      enableKeyRotation: true,
    });
    expect(keys[1]).toEqual({
      name: "search",
      keyUsage: "GENERATE_VERIFY_MAC",
      keySpec: "HMAC_256",
      enableKeyRotation: true,
    });
  });
});

describe("parseKmsAliasResources", () => {
  it("extracts the prefix-suffix portion of each alias name", () => {
    const hcl = `
resource "aws_kms_alias" "rds" {
  name = "alias/$\{var.name_prefix}-rds"
  target_key_id = aws_kms_key.rds.id
}

resource "aws_kms_alias" "documents_legacy_s3" {
  name = "alias/$\{var.name_prefix}-s3"
  target_key_id = aws_kms_key.documents.id
}
`;
    const aliases = parseKmsAliasResources(hcl);
    expect(aliases).toEqual([
      { resourceName: "rds", aliasSuffix: "rds", targetKey: "rds" },
      {
        resourceName: "documents_legacy_s3",
        aliasSuffix: "s3",
        targetKey: "documents",
      },
    ]);
  });

  it("throws on an alias missing target_key_id", () => {
    const hcl = `
resource "aws_kms_alias" "bad" {
  name = "alias/$\{var.name_prefix}-bad"
}
`;
    expect(() => parseKmsAliasResources(hcl)).toThrow(/missing either a name or target_key_id/);
  });
});

describe("extractVariableDefault", () => {
  it("returns the default of the named variable", () => {
    const hcl = `
variable "name_prefix" {
  type = string
}

variable "asymm_sign_key_spec" {
  type    = string
  default = "ECC_NIST_P256"

  validation {
    condition     = true
    error_message = "ignored"
  }
}
`;
    expect(extractVariableDefault(hcl, "asymm_sign_key_spec")).toBe("ECC_NIST_P256");
    expect(extractVariableDefault(hcl, "name_prefix")).toBeNull();
    expect(extractVariableDefault(hcl, "nonexistent")).toBeNull();
  });
});

describe("resolveKeySpec", () => {
  const varsHcl = `
variable "asymm_sign_key_spec" {
  type    = string
  default = "ECC_NIST_P256"
}
`;

  it("passes a literal spec through unchanged", () => {
    expect(resolveKeySpec("HMAC_256", varsHcl)).toBe("HMAC_256");
  });

  it("resolves a var.* reference via the variable default", () => {
    expect(resolveKeySpec({ varRef: "asymm_sign_key_spec" }, varsHcl)).toBe("ECC_NIST_P256");
  });

  it("throws when the referenced variable has no default", () => {
    const noDefault = `variable "asymm_sign_key_spec" { type = string }`;
    expect(() => resolveKeySpec({ varRef: "asymm_sign_key_spec" }, noDefault)).toThrow(
      /no default/
    );
  });
});

describe("splitMarkdownRow", () => {
  it("splits a simple row into cells", () => {
    expect(splitMarkdownRow("| a | b | c |")).toEqual([" a ", " b ", " c "]);
  });

  it("preserves backslash-escaped pipes inside cells", () => {
    expect(splitMarkdownRow("| a \\| b | c |")).toEqual([" a | b ", " c "]);
  });
});

describe("extractAliasSuffixes", () => {
  it("captures a single primary alias", () => {
    expect([...extractAliasSuffixes("`alias/<prefix>-rds`")]).toEqual(["rds"]);
  });

  it("captures the primary plus a legacy alias", () => {
    const cell = "`alias/<prefix>-data` (+ `-app-phi` legacy alias)";
    expect([...extractAliasSuffixes(cell)].sort()).toEqual(["app-phi", "data"]);
  });

  it("returns an empty set when no alias backticks are present", () => {
    expect([...extractAliasSuffixes("just a string")]).toEqual([]);
  });
});

describe("isRotationYes", () => {
  it.each([
    ["Yes (annual)", true],
    ["**Yes**", true],
    ["No (operator-driven)", false],
    ["**No** (AWS KMS does not auto-rotate)", false],
  ])("parses %j as %s", (cell, expected) => {
    expect(isRotationYes(cell)).toBe(expected);
  });

  it("throws on an unrecognised cell", () => {
    expect(() => isRotationYes("maybe")).toThrow(/does not start with 'Yes' or 'No'/);
  });
});

describe("parseInventorySummaryTable", () => {
  const md = `
# KMS Inventory

Some prose.

| #   | Key (Terraform resource) | Alias                                             | KeyUsage              | KeySpec             | Auto-rotation                                  | Owner    | Owning app(s) | Runbook entry |
| --- | ------------------------ | ------------------------------------------------- | --------------------- | ------------------- | ---------------------------------------------- | -------- | ------------- | ------------- |
| 1   | \`aws_kms_key.rds\`        | \`alias/<prefix>-rds\`                              | \`ENCRYPT_DECRYPT\`     | \`SYMMETRIC_DEFAULT\` | Yes (annual)                                   | Platform | RDS           | n/a           |
| 2   | \`aws_kms_key.search\`     | \`alias/<prefix>-search\`                           | \`GENERATE_VERIFY_MAC\` | \`HMAC_256\`          | Yes (annual)                                   | Security | web + worker  | runbook       |
| 3   | \`aws_kms_key.asymm_sign\` | \`alias/<prefix>-asymm-sign\`                       | \`SIGN_VERIFY\`         | \`ECC_NIST_P256\`     | **No** (AWS does not auto-rotate asymmetric)   | Security | worker        | runbook       |
| 4   | \`aws_kms_key.data\`       | \`alias/<prefix>-data\` (+ \`-app-phi\` legacy alias) | \`ENCRYPT_DECRYPT\`     | \`SYMMETRIC_DEFAULT\` | Yes (annual)                                   | Security | web + worker  | runbook       |

Some trailing prose.
`;

  it("parses every row in the summary table", () => {
    const rows = parseInventorySummaryTable(md);
    expect(rows.map((r) => r.keyName)).toEqual(["rds", "search", "asymm_sign", "data"]);
  });

  it("captures KeyUsage / KeySpec / rotation per row", () => {
    const rows = parseInventorySummaryTable(md);
    const search = rows.find((r) => r.keyName === "search");
    expect(search?.keyUsage).toBe("GENERATE_VERIFY_MAC");
    expect(search?.keySpec).toBe("HMAC_256");
    expect(search?.autoRotationYes).toBe(true);
    const asymm = rows.find((r) => r.keyName === "asymm_sign");
    expect(asymm?.autoRotationYes).toBe(false);
  });

  it("captures both the primary and legacy alias suffixes", () => {
    const rows = parseInventorySummaryTable(md);
    const data = rows.find((r) => r.keyName === "data");
    expect([...(data?.aliasSuffixes ?? [])].sort()).toEqual(["app-phi", "data"]);
  });

  it("throws when the summary table is missing entirely", () => {
    expect(() => parseInventorySummaryTable("# nothing here")).toThrow(/summary table not found/);
  });
});

describe("compareKmsState — drift detection", () => {
  const baseTfKey = {
    name: "rds",
    keyUsage: "ENCRYPT_DECRYPT",
    keySpec: "SYMMETRIC_DEFAULT",
    enableKeyRotation: true,
  } as const;
  const baseInventory = {
    keyName: "rds",
    aliasSuffixes: new Set(["rds"]),
    keyUsage: "ENCRYPT_DECRYPT",
    keySpec: "SYMMETRIC_DEFAULT",
    autoRotationYes: true,
    rawRotationCell: "Yes (annual)",
  } as const;
  const baseTfAlias = {
    resourceName: "rds",
    aliasSuffix: "rds",
    targetKey: "rds",
  } as const;

  it("returns [] when everything matches", () => {
    const issues = compareKmsState({
      tfKeys: [baseTfKey],
      tfAliases: [baseTfAlias],
      inventory: [baseInventory],
      varsHcl: "",
    });
    expect(issues).toEqual([]);
  });

  it("flags a key present in TF but missing from the inventory", () => {
    const issues = compareKmsState({
      tfKeys: [baseTfKey, { ...baseTfKey, name: "extra" }],
      tfAliases: [baseTfAlias],
      inventory: [baseInventory],
      varsHcl: "",
    });
    expect(issues).toContainEqual({ kind: "key-missing-from-inventory", key: "extra" });
  });

  it("flags a key present in inventory but missing from TF", () => {
    const issues = compareKmsState({
      tfKeys: [baseTfKey],
      tfAliases: [baseTfAlias],
      inventory: [baseInventory, { ...baseInventory, keyName: "ghost" }],
      varsHcl: "",
    });
    expect(issues).toContainEqual({ kind: "key-missing-from-terraform", key: "ghost" });
  });

  it("flags KeyUsage mismatch", () => {
    const issues = compareKmsState({
      tfKeys: [{ ...baseTfKey, keyUsage: "GENERATE_VERIFY_MAC" }],
      tfAliases: [baseTfAlias],
      inventory: [baseInventory],
      varsHcl: "",
    });
    expect(issues).toContainEqual({
      kind: "key-usage-mismatch",
      key: "rds",
      tf: "GENERATE_VERIFY_MAC",
      inventory: "ENCRYPT_DECRYPT",
    });
  });

  it("flags KeySpec mismatch (with variable resolution)", () => {
    const issues = compareKmsState({
      tfKeys: [{ ...baseTfKey, keySpec: { varRef: "asymm_sign_key_spec" } }],
      tfAliases: [baseTfAlias],
      inventory: [baseInventory],
      varsHcl: `variable "asymm_sign_key_spec" { default = "ECC_NIST_P256" }`,
    });
    expect(issues).toContainEqual({
      kind: "key-spec-mismatch",
      key: "rds",
      tf: "ECC_NIST_P256",
      inventory: "SYMMETRIC_DEFAULT",
    });
  });

  it("flags rotation mismatch", () => {
    const issues = compareKmsState({
      tfKeys: [{ ...baseTfKey, enableKeyRotation: false }],
      tfAliases: [baseTfAlias],
      inventory: [baseInventory],
      varsHcl: "",
    });
    expect(issues).toContainEqual({
      kind: "rotation-mismatch",
      key: "rds",
      tfEnabled: false,
      inventoryCell: "Yes (annual)",
    });
  });

  it("flags an alias present in TF but missing from the inventory row", () => {
    const issues = compareKmsState({
      tfKeys: [baseTfKey],
      tfAliases: [
        baseTfAlias,
        { resourceName: "rds_legacy", aliasSuffix: "rds-old", targetKey: "rds" },
      ],
      inventory: [baseInventory],
      varsHcl: "",
    });
    expect(issues).toContainEqual({
      kind: "alias-missing-from-inventory",
      aliasResource: "rds_legacy",
      aliasSuffix: "rds-old",
      key: "rds",
    });
  });

  it("flags an alias mentioned in the inventory but absent from TF", () => {
    const inventoryWithExtra = {
      ...baseInventory,
      aliasSuffixes: new Set(["rds", "fictional"]),
    };
    const issues = compareKmsState({
      tfKeys: [baseTfKey],
      tfAliases: [baseTfAlias],
      inventory: [inventoryWithExtra],
      varsHcl: "",
    });
    expect(issues).toContainEqual({
      kind: "alias-missing-from-terraform",
      aliasSuffix: "fictional",
      key: "rds",
    });
  });
});

describe("formatDriftReport", () => {
  it("returns the clean-message string when there are no issues", () => {
    expect(formatDriftReport([])).toMatch(/in sync/);
  });

  it("includes a remediation hint for every issue kind", () => {
    const report = formatDriftReport([
      { kind: "key-missing-from-inventory", key: "alpha" },
      { kind: "key-missing-from-terraform", key: "beta" },
      {
        kind: "key-usage-mismatch",
        key: "gamma",
        tf: "GENERATE_VERIFY_MAC",
        inventory: "ENCRYPT_DECRYPT",
      },
      { kind: "key-spec-mismatch", key: "delta", tf: "HMAC_256", inventory: "SYMMETRIC_DEFAULT" },
      { kind: "rotation-mismatch", key: "epsilon", tfEnabled: false, inventoryCell: "Yes" },
      {
        kind: "alias-missing-from-inventory",
        aliasResource: "zeta_alt",
        aliasSuffix: "zeta-old",
        key: "zeta",
      },
      { kind: "alias-missing-from-terraform", aliasSuffix: "fictional", key: "eta" },
    ]);
    expect(report).toContain("aws_kms_key.alpha");
    expect(report).toContain("aws_kms_key.beta");
    expect(report).toContain("KeyUsage drift");
    expect(report).toContain("KeySpec drift");
    expect(report).toContain("enable_key_rotation=false");
    expect(report).toContain("alias/<prefix>-zeta-old");
    expect(report).toContain("'fictional'");
    expect(report).toContain("Fix the drift in the same PR");
  });
});
