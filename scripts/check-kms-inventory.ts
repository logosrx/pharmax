#!/usr/bin/env tsx
// scripts/check-kms-inventory.ts
//
// Pre-merge guard. Diffs the customer-managed KMS key inventory in
// `docs/security/kms-key-inventory.md` against the source of truth in
// `infra/terraform/modules/kms/main.tf`. Fails the PR on drift.
//
// Why this guard exists:
//
//   The inventory document is the auditor-facing "what keys exist,
//   what does each protect, how does each rotate" surface. The
//   Terraform module is the IaC truth — what actually gets
//   provisioned. The two MUST agree. Without an automated check, an
//   engineer who adds, removes, or repurposes a KMS key can ship the
//   IaC change while forgetting the doc; the inventory then silently
//   misleads the next auditor reading it.
//
//   This guard closes the `kms3` follow-up tracked in
//   `docs/security/kms-key-inventory.md` § 7 and the G4 (KMS) row of
//   `docs/soc2/code-evidence-map.md`.
//
// What it checks:
//
//   1. Key resource parity. Every `aws_kms_key.<name>` resource in
//      the Terraform module appears as an `aws_kms_key.<name>` row in
//      the inventory's § 3.1 summary table — and vice versa.
//
//   2. KeyUsage parity. Each TF key's `key_usage = "..."` (or the
//      implicit default `ENCRYPT_DECRYPT` when the field is absent)
//      matches the `KeyUsage` column of the inventory row.
//
//   3. KeySpec parity. Each TF key's `customer_master_key_spec` (or
//      the implicit default `SYMMETRIC_DEFAULT` when absent) matches
//      the `KeySpec` column. Variable references like
//      `var.asymm_sign_key_spec` are resolved via the variable's
//      `default` value in `infra/terraform/modules/kms/variables.tf`.
//
//   4. Auto-rotation parity. `enable_key_rotation = true` ↔ an
//      inventory cell that begins with the word "Yes"; absence or
//      `false` ↔ a cell that begins with the word "No" (the asymmetric
//      `aws_kms_key.asymm_sign` case, where AWS does not auto-rotate).
//
//   5. Alias parity. For each `aws_kms_alias.<aliasName>` in TF that
//      targets `aws_kms_key.<keyName>.id`, the alias name suffix
//      (everything after `<prefix>-`) must appear in the inventory row
//      for the owning key. Legacy aliases (e.g.
//      `aws_kms_alias.documents_legacy_s3` → `alias/<prefix>-s3`) are
//      load-bearing for runtime backwards compatibility and MUST be
//      documented.
//
// What it does NOT check (out of scope; addressed by other gates):
//
//   - IAM grants on the key (lives in `modules/iam/main.tf`; reviewed
//     by `terraform validate` + a code reviewer).
//   - Key policy contents (resource policy strings inside the TF
//     module; structural review at code-review time).
//   - The actual KMS API behaviour on a real AWS account (runtime
//     concern; `pnpm verify:kms` is the smoke test, the daily
//     `terraform-drift` workflow is the long-run posture check).
//   - The narrative prose in §3.2 sub-sections (semantic content;
//     reviewed at PR time, not automatable without LLM judgement).
//
// Exit code:
//   0  Inventory and Terraform are in sync.
//   1  Drift found. Detailed diff printed to stderr.
//   2  Internal error (one of the source files is missing or
//      unparseable; the PR should be considered broken).
//
// Designed to run BEFORE `pnpm test`, alongside the other pharmacy
// safety linters (`check:migrations`, `check:schema`, `check:commands`,
// `check:event-reasons`) in the `safety-linters` CI job.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- types --------------------------------------------------------

/**
 * A resource extracted from `infra/terraform/modules/kms/main.tf`.
 *
 * `keySpec` is left in its "raw" form during the parse pass: either a
 * literal AWS KeySpec string ("SYMMETRIC_DEFAULT", "HMAC_256",
 * "ECC_NIST_P256", ...) or a variable reference of the shape
 * `{ varRef: "asymm_sign_key_spec" }` that the resolver later expands
 * by looking up `default = "..."` in `variables.tf`. Splitting the
 * passes keeps the parser dumb and the variable lookup explicit.
 */
export interface TfKeyResource {
  readonly name: string;
  readonly keyUsage: string;
  readonly keySpec: string | { readonly varRef: string };
  readonly enableKeyRotation: boolean;
}

/**
 * A resource extracted from `infra/terraform/modules/kms/main.tf`.
 *
 * `aliasSuffix` is the slice AFTER the `<prefix>-` portion of the
 * alias name (so `alias/${var.name_prefix}-rds` becomes `"rds"`).
 * Inventory rows quote suffixes the same way (e.g.
 * `alias/<prefix>-rds`), so the parsed suffix is what we compare.
 */
export interface TfAliasResource {
  readonly resourceName: string;
  readonly aliasSuffix: string;
  readonly targetKey: string;
}

/**
 * A single row from `docs/security/kms-key-inventory.md` § 3.1
 * summary table. Aliases is the parsed set of suffixes — typically
 * one ("rds"), occasionally two when a legacy alias is documented
 * inline ("data + app-phi legacy alias").
 */
export interface InventoryEntry {
  readonly keyName: string;
  readonly aliasSuffixes: ReadonlySet<string>;
  readonly keyUsage: string;
  readonly keySpec: string;
  readonly autoRotationYes: boolean;
  readonly rawRotationCell: string;
}

export type DriftIssue =
  | {
      readonly kind: "key-missing-from-inventory";
      readonly key: string;
    }
  | {
      readonly kind: "key-missing-from-terraform";
      readonly key: string;
    }
  | {
      readonly kind: "key-usage-mismatch";
      readonly key: string;
      readonly tf: string;
      readonly inventory: string;
    }
  | {
      readonly kind: "key-spec-mismatch";
      readonly key: string;
      readonly tf: string;
      readonly inventory: string;
    }
  | {
      readonly kind: "rotation-mismatch";
      readonly key: string;
      readonly tfEnabled: boolean;
      readonly inventoryCell: string;
    }
  | {
      readonly kind: "alias-missing-from-inventory";
      readonly aliasResource: string;
      readonly aliasSuffix: string;
      readonly key: string;
    }
  | {
      readonly kind: "alias-missing-from-terraform";
      readonly aliasSuffix: string;
      readonly key: string;
    };

// ---- HCL: parse `aws_kms_key.*` resources -------------------------

/**
 * Walk an HCL string and return the bodies of every
 * `resource "<resourceType>" "<resourceName>" { ... }` block matching
 * `resourceType`. The body is everything between the matching braces,
 * with nested braces respected. Returns one entry per block.
 *
 * The walker is a simple brace-counting state machine rather than a
 * regex because resource bodies routinely contain nested blocks
 * (`tags { ... }`, `condition { ... }`), which a flat regex cannot
 * pair correctly.
 */
export function extractResourceBlocks(
  hcl: string,
  resourceType: string
): ReadonlyArray<{ readonly name: string; readonly body: string }> {
  const out: { name: string; body: string }[] = [];
  // Anchor to start-of-line so a string literal containing
  // `resource "..."` inside a description doesn't false-match.
  const headerRe = new RegExp(
    `^\\s*resource\\s+"${escapeRegExp(resourceType)}"\\s+"([^"]+)"\\s*\\{`,
    "gm"
  );
  let header: RegExpExecArray | null;
  while ((header = headerRe.exec(hcl)) !== null) {
    const resourceName = header[1];
    if (resourceName === undefined) continue;
    // header[0] ends with the opening `{`; start scanning from there.
    const openBraceIdx = header.index + header[0].length - 1;
    const closeBraceIdx = findMatchingCloseBrace(hcl, openBraceIdx);
    if (closeBraceIdx === -1) {
      throw new Error(
        `Unterminated resource block for resource "${resourceType}" "${resourceName}" starting at offset ${header.index}.`
      );
    }
    const body = hcl.slice(openBraceIdx + 1, closeBraceIdx);
    out.push({ name: resourceName, body });
    // Advance past the closing brace so the next match can start.
    headerRe.lastIndex = closeBraceIdx + 1;
  }
  return out;
}

/**
 * Given the index of an opening `{` in `s`, return the index of the
 * matching `}`. Respects nested `{ ... }` pairs. Returns `-1` if no
 * matching close brace exists.
 *
 * The walker honours `# ...` and `// ...` line comments and
 * slash-star block comments — comment text never affects nesting.
 * It does not attempt to parse strings; HCL strings can contain
 * `}` so a naive walker would mis-pair. The MITIGATION: the KMS
 * module deliberately avoids string-literal `{` or `}` inside resource
 * bodies (an HCL convention). If a future module breaks that
 * convention, this walker needs the string-literal branch added.
 */
export function findMatchingCloseBrace(s: string, openIdx: number): number {
  if (s.charCodeAt(openIdx) !== 0x7b /* '{' */) {
    throw new Error(
      `findMatchingCloseBrace: expected '{' at offset ${openIdx}, got '${s.charAt(openIdx)}'.`
    );
  }
  let depth = 0;
  let i = openIdx;
  while (i < s.length) {
    const c = s.charAt(i);
    // Skip a `#` or `//` line comment to end of line.
    if (c === "#" || (c === "/" && s.charAt(i + 1) === "/")) {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl + 1;
      continue;
    }
    // Skip a `/* ... */` block comment.
    if (c === "/" && s.charAt(i + 1) === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the body of an `aws_kms_key` resource and extract the four
 * attributes the inventory pins. The argument is just the body
 * string (the `{ ... }` contents); see `extractResourceBlocks`.
 *
 * Defaults applied (mirroring AWS KMS defaults that Terraform
 * inherits when an attribute is omitted):
 *   - key_usage absent                → ENCRYPT_DECRYPT
 *   - customer_master_key_spec absent → SYMMETRIC_DEFAULT
 *   - enable_key_rotation absent      → false (the AWS default)
 */
export function parseKmsKeyBody(body: string): {
  readonly keyUsage: string;
  readonly keySpec: TfKeyResource["keySpec"];
  readonly enableKeyRotation: boolean;
} {
  const keyUsageMatch = /\bkey_usage\s*=\s*"([^"]+)"/.exec(body);
  const keyUsage = keyUsageMatch?.[1] ?? "ENCRYPT_DECRYPT";

  const specLiteralMatch = /\bcustomer_master_key_spec\s*=\s*"([^"]+)"/.exec(body);
  const specVarMatch = /\bcustomer_master_key_spec\s*=\s*var\.(\w+)/.exec(body);
  let keySpec: TfKeyResource["keySpec"];
  if (specLiteralMatch) {
    keySpec = specLiteralMatch[1] ?? "SYMMETRIC_DEFAULT";
  } else if (specVarMatch && specVarMatch[1] !== undefined) {
    keySpec = { varRef: specVarMatch[1] };
  } else {
    keySpec = "SYMMETRIC_DEFAULT";
  }

  const rotationMatch = /\benable_key_rotation\s*=\s*(true|false)\b/.exec(body);
  const enableKeyRotation = rotationMatch ? rotationMatch[1] === "true" : false;

  return { keyUsage, keySpec, enableKeyRotation };
}

/**
 * Parse `aws_kms_key.*` resources from a Terraform HCL string into
 * the structured form the comparator consumes.
 */
export function parseKmsKeyResources(hcl: string): ReadonlyArray<TfKeyResource> {
  return extractResourceBlocks(hcl, "aws_kms_key").map((block) => ({
    name: block.name,
    ...parseKmsKeyBody(block.body),
  }));
}

/**
 * Parse `aws_kms_alias.*` resources from a Terraform HCL string. The
 * alias name in the module is built from `${var.name_prefix}-<suffix>`;
 * we extract the `<suffix>` part for comparison against the inventory's
 * `alias/<prefix>-<suffix>` notation. Aliases that don't follow the
 * prefix convention (a future structural change) are returned with
 * `aliasSuffix = "<raw>"` so the cross-check still surfaces them.
 */
export function parseKmsAliasResources(hcl: string): ReadonlyArray<TfAliasResource> {
  const blocks = extractResourceBlocks(hcl, "aws_kms_alias");
  const out: TfAliasResource[] = [];
  for (const block of blocks) {
    const nameMatch =
      /\bname\s*=\s*"alias\/\$\{var\.name_prefix\}-([^"]+)"/.exec(block.body) ??
      /\bname\s*=\s*"alias\/([^"]+)"/.exec(block.body);
    const targetMatch = /\btarget_key_id\s*=\s*aws_kms_key\.(\w+)\.id/.exec(block.body);
    if (!nameMatch || !targetMatch) {
      throw new Error(
        `Alias resource "${block.name}" is missing either a name or target_key_id binding.`
      );
    }
    out.push({
      resourceName: block.name,
      aliasSuffix: nameMatch[1] ?? "",
      targetKey: targetMatch[1] ?? "",
    });
  }
  return out;
}

/**
 * Find the `default = "..."` value of a `variable "<name>"` block in
 * a variables.tf HCL string. Returns null if either the variable is
 * absent or the block omits a default.
 */
export function extractVariableDefault(varsHcl: string, varName: string): string | null {
  const headerRe = new RegExp(`variable\\s+"${escapeRegExp(varName)}"\\s*\\{`, "g");
  const header = headerRe.exec(varsHcl);
  if (!header) return null;
  const openBraceIdx = header.index + header[0].length - 1;
  const closeBraceIdx = findMatchingCloseBrace(varsHcl, openBraceIdx);
  if (closeBraceIdx === -1) return null;
  const body = varsHcl.slice(openBraceIdx + 1, closeBraceIdx);
  const defaultMatch = /\bdefault\s*=\s*"([^"]+)"/.exec(body);
  return defaultMatch?.[1] ?? null;
}

/**
 * Resolve a parsed key spec to its concrete string value. Literal
 * specs pass through; variable references are looked up in the
 * provided variables.tf body. A variable reference with no default
 * throws — the inventory cannot pin a value the IaC leaves unbound.
 */
export function resolveKeySpec(spec: TfKeyResource["keySpec"], varsHcl: string): string {
  if (typeof spec === "string") return spec;
  const resolved = extractVariableDefault(varsHcl, spec.varRef);
  if (resolved === null) {
    throw new Error(
      `customer_master_key_spec references var.${spec.varRef} but the variable has no default in variables.tf — the inventory cannot pin a value the IaC leaves unbound.`
    );
  }
  return resolved;
}

// ---- Markdown: parse the § 3.1 summary table ----------------------

/**
 * Parse rows out of the § 3.1 summary table in the inventory
 * markdown. The expected columns (matched by header text, not
 * position, to tolerate column reordering):
 *
 *   #, Key (Terraform resource), Alias, KeyUsage, KeySpec,
 *   Auto-rotation, Owner, Owning app(s), Runbook entry
 *
 * Rows are accepted between the first GFM table header row that
 * contains "Key (Terraform resource)" and the following blank line.
 *
 * Cell formatting accepted:
 *   - `aws_kms_key.<name>` in backticks (the canonical form).
 *   - `<usage>` and `<spec>` in backticks.
 *   - Alias cell of the shape "`alias/<prefix>-rds`" or
 *     "`alias/<prefix>-data` (+ `-app-phi` legacy alias)" — multiple
 *     alias suffixes are extracted; the prefix wildcard
 *     "`<prefix>-`" is stripped, leaving the suffix.
 */
export function parseInventorySummaryTable(md: string): ReadonlyArray<InventoryEntry> {
  const lines = md.split(/\r?\n/);
  // Find a header row whose cells include "Key (Terraform resource)".
  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!line.includes("|")) continue;
    if (!/key \(terraform resource\)/i.test(line)) continue;
    const cells = splitMarkdownRow(line);
    if (cells.some((c) => /key \(terraform resource\)/i.test(c))) {
      headerIdx = i;
      headers = cells.map((c) => c.trim().toLowerCase());
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(
      "Inventory § 3.1 summary table not found — header row containing 'Key (Terraform resource)' is missing."
    );
  }

  const col = (name: string): number => {
    const idx = headers.findIndex((h) => h === name.toLowerCase());
    if (idx === -1) {
      throw new Error(
        `Inventory § 3.1 summary table is missing required column '${name}'. Headers found: ${headers.join(", ")}`
      );
    }
    return idx;
  };
  const idxKey = col("Key (Terraform resource)");
  const idxAlias = col("Alias");
  const idxUsage = col("KeyUsage");
  const idxSpec = col("KeySpec");
  const idxRotation = col("Auto-rotation");

  // Skip the alignment row (the `|---|---|...` row immediately
  // following the header) by starting at headerIdx + 2.
  const out: InventoryEntry[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === "") break;
    if (!trimmed.startsWith("|")) break;
    const cells = splitMarkdownRow(line);
    const rawKey = cells[idxKey]?.trim() ?? "";
    const keyMatch = /`aws_kms_key\.(\w+)`/.exec(rawKey);
    if (!keyMatch) continue;
    const keyName = keyMatch[1] ?? "";
    const rawAlias = cells[idxAlias]?.trim() ?? "";
    const aliasSuffixes = extractAliasSuffixes(rawAlias);
    const rawUsage = cells[idxUsage]?.trim() ?? "";
    const usageMatch = /`([A-Z_]+)`/.exec(rawUsage);
    const rawSpec = cells[idxSpec]?.trim() ?? "";
    const specMatch = /`([A-Z0-9_]+)`/.exec(rawSpec);
    const rawRotationCell = cells[idxRotation]?.trim() ?? "";
    out.push({
      keyName,
      aliasSuffixes,
      keyUsage: usageMatch?.[1] ?? rawUsage,
      keySpec: specMatch?.[1] ?? rawSpec,
      autoRotationYes: isRotationYes(rawRotationCell),
      rawRotationCell,
    });
  }
  return out;
}

/**
 * Split a GFM table row into its cell strings. Leading + trailing
 * pipes are stripped; backslash-escaped pipes (`\\|`) inside a cell
 * survive. Backtick spans are NOT specially handled — a backtick
 * span containing `|` would mis-split here, but the inventory does
 * not use them in those columns.
 */
export function splitMarkdownRow(line: string): string[] {
  // Strip the leading/trailing `|` if present.
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "\\" && s.charAt(i + 1) === "|") {
      buf += "|";
      i++;
      continue;
    }
    if (c === "|") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

/**
 * Extract alias suffixes from an inventory Alias-column cell.
 * Recognised shapes:
 *   - `alias/<prefix>-rds`
 *   - `alias/<prefix>-data` (+ `-app-phi` legacy alias)
 *   - `alias/<prefix>-foo`, `alias/<prefix>-bar` (rare; comma-listed)
 *
 * The `<prefix>-` marker is parser-magical — the inventory uses the
 * literal placeholder text "`<prefix>-`" in its alias column, and
 * legacy aliases are quoted as "`-<suffix>`" (with the leading dash).
 * Stripping the leading dash yields the comparable suffix.
 */
export function extractAliasSuffixes(cell: string): ReadonlySet<string> {
  const out = new Set<string>();
  const primaryRe = /`alias\/<prefix>-([\w-]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = primaryRe.exec(cell)) !== null) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  // Legacy aliases are quoted as `-<suffix>` parenthetically — but
  // we also accept them with or without the leading dash, since the
  // inventory format has wobbled historically.
  const legacyRe = /`-([\w-]+)`\s+legacy/g;
  while ((m = legacyRe.exec(cell)) !== null) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return out;
}

/**
 * The Auto-rotation cell starts with "Yes" or "No" (the asymmetric
 * key's row begins with `**No**` because it's the structurally
 * different case worth bolding). This helper normalises both forms.
 *
 * Strips markdown emphasis markers (`**`, `*`) before checking, so
 * `**Yes**`, `*Yes*`, and plain `Yes` all parse the same way.
 */
export function isRotationYes(cell: string): boolean {
  const stripped = cell.replace(/^[*_]+|[*_]+$/g, "").trim();
  if (/^yes\b/i.test(stripped)) return true;
  if (/^no\b/i.test(stripped)) return false;
  throw new Error(`Auto-rotation cell does not start with 'Yes' or 'No': ${JSON.stringify(cell)}`);
}

// ---- Cross-check ---------------------------------------------------

/**
 * Compare the parsed Terraform state to the parsed inventory state
 * and return a (possibly empty) list of drift issues. Pure function —
 * the CLI wrapper composes it with `process.exit`.
 *
 * `varsHcl` is the variables.tf body for resolving `var.xxx`
 * references to their `default = "..."` values; passing an empty
 * string is fine as long as no key actually references a variable.
 */
export function compareKmsState(input: {
  readonly tfKeys: ReadonlyArray<TfKeyResource>;
  readonly tfAliases: ReadonlyArray<TfAliasResource>;
  readonly inventory: ReadonlyArray<InventoryEntry>;
  readonly varsHcl: string;
}): ReadonlyArray<DriftIssue> {
  const issues: DriftIssue[] = [];

  const tfKeyByName = new Map(input.tfKeys.map((k) => [k.name, k] as const));
  const invByName = new Map(input.inventory.map((e) => [e.keyName, e] as const));

  // 1. Key resource parity.
  for (const tfKey of input.tfKeys) {
    if (!invByName.has(tfKey.name)) {
      issues.push({ kind: "key-missing-from-inventory", key: tfKey.name });
    }
  }
  for (const inv of input.inventory) {
    if (!tfKeyByName.has(inv.keyName)) {
      issues.push({ kind: "key-missing-from-terraform", key: inv.keyName });
    }
  }

  // 2 / 3 / 4. Attribute parity for keys that exist in BOTH.
  for (const tfKey of input.tfKeys) {
    const inv = invByName.get(tfKey.name);
    if (!inv) continue;
    if (tfKey.keyUsage !== inv.keyUsage) {
      issues.push({
        kind: "key-usage-mismatch",
        key: tfKey.name,
        tf: tfKey.keyUsage,
        inventory: inv.keyUsage,
      });
    }
    const resolvedSpec = resolveKeySpec(tfKey.keySpec, input.varsHcl);
    if (resolvedSpec !== inv.keySpec) {
      issues.push({
        kind: "key-spec-mismatch",
        key: tfKey.name,
        tf: resolvedSpec,
        inventory: inv.keySpec,
      });
    }
    if (tfKey.enableKeyRotation !== inv.autoRotationYes) {
      issues.push({
        kind: "rotation-mismatch",
        key: tfKey.name,
        tfEnabled: tfKey.enableKeyRotation,
        inventoryCell: inv.rawRotationCell,
      });
    }
  }

  // 5. Alias parity. Group TF aliases by target key.
  const tfAliasSuffixesByKey = new Map<string, Set<string>>();
  for (const alias of input.tfAliases) {
    let set = tfAliasSuffixesByKey.get(alias.targetKey);
    if (!set) {
      set = new Set<string>();
      tfAliasSuffixesByKey.set(alias.targetKey, set);
    }
    set.add(alias.aliasSuffix);
  }
  for (const alias of input.tfAliases) {
    const inv = invByName.get(alias.targetKey);
    if (!inv) continue; // Already reported as key-missing-from-inventory.
    if (!inv.aliasSuffixes.has(alias.aliasSuffix)) {
      issues.push({
        kind: "alias-missing-from-inventory",
        aliasResource: alias.resourceName,
        aliasSuffix: alias.aliasSuffix,
        key: alias.targetKey,
      });
    }
  }
  for (const inv of input.inventory) {
    const tfSuffixes = tfAliasSuffixesByKey.get(inv.keyName);
    if (!tfSuffixes) continue; // Already reported as key-missing-from-terraform.
    for (const invSuffix of inv.aliasSuffixes) {
      if (!tfSuffixes.has(invSuffix)) {
        issues.push({
          kind: "alias-missing-from-terraform",
          aliasSuffix: invSuffix,
          key: inv.keyName,
        });
      }
    }
  }

  return issues;
}

/**
 * Render a drift report as a human-readable, copy-pasteable
 * remediation guide. One section per drift kind; each section names
 * the file the engineer should edit to fix the drift.
 */
export function formatDriftReport(issues: ReadonlyArray<DriftIssue>): string {
  if (issues.length === 0) {
    return "KMS inventory is in sync with infra/terraform/modules/kms/main.tf.";
  }
  const lines: string[] = [];
  lines.push(
    `Found ${issues.length} drift issue${issues.length === 1 ? "" : "s"} between docs/security/kms-key-inventory.md and infra/terraform/modules/kms/main.tf:`,
    ""
  );
  for (const issue of issues) {
    switch (issue.kind) {
      case "key-missing-from-inventory":
        lines.push(
          `  ✗ aws_kms_key.${issue.key} is in Terraform but missing from the inventory § 3.1 summary table.`,
          `    → Edit docs/security/kms-key-inventory.md and add a row for this key.`
        );
        break;
      case "key-missing-from-terraform":
        lines.push(
          `  ✗ aws_kms_key.${issue.key} is in the inventory but missing from Terraform.`,
          `    → Either add the resource to infra/terraform/modules/kms/main.tf, or remove the row from the inventory.`
        );
        break;
      case "key-usage-mismatch":
        lines.push(
          `  ✗ aws_kms_key.${issue.key} KeyUsage drift: terraform=${issue.tf}, inventory=${issue.inventory}.`,
          `    → The Terraform module is the source of truth. Update the inventory's KeyUsage column to '${issue.tf}'.`
        );
        break;
      case "key-spec-mismatch":
        lines.push(
          `  ✗ aws_kms_key.${issue.key} KeySpec drift: terraform=${issue.tf}, inventory=${issue.inventory}.`,
          `    → The Terraform module is the source of truth. Update the inventory's KeySpec column to '${issue.tf}'.`
        );
        break;
      case "rotation-mismatch":
        lines.push(
          `  ✗ aws_kms_key.${issue.key} auto-rotation drift: terraform enable_key_rotation=${issue.tfEnabled}, inventory cell=${JSON.stringify(issue.inventoryCell)}.`,
          `    → Update the inventory's Auto-rotation column so it begins with '${issue.tfEnabled ? "Yes" : "No"}'.`
        );
        break;
      case "alias-missing-from-inventory":
        lines.push(
          `  ✗ aws_kms_alias.${issue.aliasResource} (alias/<prefix>-${issue.aliasSuffix} → aws_kms_key.${issue.key}) is in Terraform but missing from the inventory.`,
          `    → Edit the Alias column of the aws_kms_key.${issue.key} row to mention 'alias/<prefix>-${issue.aliasSuffix}'.`
        );
        break;
      case "alias-missing-from-terraform":
        lines.push(
          `  ✗ Inventory says aws_kms_key.${issue.key} has alias suffix '${issue.aliasSuffix}', but no aws_kms_alias resource targets it.`,
          `    → Either add the alias resource to Terraform, or drop the mention from the inventory.`
        );
        break;
    }
  }
  lines.push(
    "",
    "Fix the drift in the same PR that introduced it. The inventory is the auditor-facing surface; the Terraform module is the IaC truth; the two MUST stay in lockstep."
  );
  return lines.join("\n");
}

// ---- CLI entry point ----------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TF_MAIN = join(ROOT, "infra", "terraform", "modules", "kms", "main.tf");
const TF_VARS = join(ROOT, "infra", "terraform", "modules", "kms", "variables.tf");
const INVENTORY_MD = join(ROOT, "docs", "security", "kms-key-inventory.md");

/**
 * The CLI entry point. Reads both files from disk, runs the check,
 * prints the report, and returns the exit code.
 *
 * Exposed (not just inlined under `import.meta.url === ...`) so a
 * future caller can drive the check from inside another harness
 * without spawning a process.
 */
export function runFromFilesystem(): number {
  let tfMain: string;
  let tfVars: string;
  let inventoryMd: string;
  try {
    tfMain = readFileSync(TF_MAIN, "utf8");
    tfVars = readFileSync(TF_VARS, "utf8");
    inventoryMd = readFileSync(INVENTORY_MD, "utf8");
  } catch (err) {
    process.stderr.write(
      `check-kms-inventory: failed to read one of the source files (${(err as Error).message}). This script expects the layout:\n` +
        `  infra/terraform/modules/kms/main.tf\n` +
        `  infra/terraform/modules/kms/variables.tf\n` +
        `  docs/security/kms-key-inventory.md\n`
    );
    return 2;
  }
  try {
    const tfKeys = parseKmsKeyResources(tfMain);
    const tfAliases = parseKmsAliasResources(tfMain);
    const inventory = parseInventorySummaryTable(inventoryMd);
    const issues = compareKmsState({
      tfKeys,
      tfAliases,
      inventory,
      varsHcl: tfVars,
    });
    const report = formatDriftReport(issues);
    if (issues.length === 0) {
      process.stdout.write(report + "\n");
      return 0;
    }
    process.stderr.write(report + "\n");
    return 1;
  } catch (err) {
    process.stderr.write(
      `check-kms-inventory: internal error during parse/compare: ${(err as Error).message}\n`
    );
    return 2;
  }
}

// Run when invoked as a script. The `process.argv[1]` guard makes
// the file safely importable from a test without triggering main().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runFromFilesystem());
}
