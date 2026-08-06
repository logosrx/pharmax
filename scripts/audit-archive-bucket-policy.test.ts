// Parity guard for the audit-archive bucket policy.
//
// `infra/terraform/modules/s3-audit-archive/main.tf` documents its DENY
// statements in `local.bucket_policy_denies` and implements them in
// `data "aws_iam_policy_document" "bucket"`. A `precondition` on the
// bucket-policy resource already fails `terraform plan` when the two
// diverge — but plan only runs in the deploy workflow, and the drift this
// module actually suffered (a fourth DENY documented for months, never
// implemented) is exactly the kind that wants catching at PR time.
//
// So this runs in `pnpm verify`, where every change to the module is seen.
//
// It deliberately parses the HCL rather than running Terraform: rendering
// the policy document needs a provider and a bucket ARN, and the property
// under test — "the list and the statements agree" — is textual.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_MAIN_TF = join(ROOT, "infra", "terraform", "modules", "s3-audit-archive", "main.tf");

/**
 * Index of the `}` matching the `{` at `openIdx`.
 *
 * `check-kms-inventory.ts` exports a walker for the same job, but it treats
 * `/*` as the start of a block comment and this module's resource ARNs are
 * written `"${aws_s3_bucket.this.arn}/*"`. Rather than loosen a helper the
 * KMS guard depends on, this walker skips over double-quoted strings — which
 * is what makes it safe here, since those strings hold both the `/*` and the
 * `${...}` interpolation braces.
 */
function matchingCloseBrace(s: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '"') {
      i += 1;
      while (i < s.length) {
        if (s.charAt(i) === "\\") {
          i += 2;
          continue;
        }
        if (s.charAt(i) === '"') break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "#" || (c === "/" && s.charAt(i + 1) === "/")) {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl + 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Body of the first block whose header matches, e.g. `locals`. */
function blockBody(hcl: string, header: string, from = 0): string {
  const headerRe = new RegExp(
    `^[ \\t]*${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`,
    "m"
  );
  const match = headerRe.exec(hcl.slice(from));
  if (match === null) throw new Error(`Block "${header}" not found in ${MODULE_MAIN_TF}.`);
  const openBraceIdx = from + match.index + match[0].length - 1;
  const closeBraceIdx = matchingCloseBrace(hcl, openBraceIdx);
  if (closeBraceIdx === -1) throw new Error(`Block "${header}" is unterminated.`);
  return hcl.slice(openBraceIdx + 1, closeBraceIdx);
}

/** The sids the module documents in `local.bucket_policy_denies`. */
function documentedSids(hcl: string): ReadonlyArray<string> {
  // Anchor on the assignment, not the identifier — the comment above the
  // policy document names `local.bucket_policy_denies` in prose.
  const assignment = /\bbucket_policy_denies\s*=\s*\{/.exec(hcl);
  if (assignment === null) {
    throw new Error("local.bucket_policy_denies not found — the DENY enumeration is missing.");
  }
  const mapOpen = assignment.index + assignment[0].length - 1;
  const mapClose = matchingCloseBrace(hcl, mapOpen);
  const mapBody = hcl.slice(mapOpen + 1, mapClose);
  // Strip comments so a sid named in the prose of a comment is not counted
  // as a key of the map.
  const withoutComments = mapBody.replace(/#[^\n]*/g, "");
  return [...withoutComments.matchAll(/^\s*(\w+)\s*=/gm)].map((entry) => entry[1] as string).sort();
}

/** The sids the module actually implements, in file order. */
function implementedSids(hcl: string): ReadonlyArray<string> {
  const body = blockBody(hcl, 'data "aws_iam_policy_document" "bucket"');
  return [...body.matchAll(/\bsid\s*=\s*"([^"]+)"/g)].map((entry) => entry[1] as string);
}

describe("s3-audit-archive bucket policy", () => {
  const hcl = readFileSync(MODULE_MAIN_TF, "utf8");

  it("implements exactly the DENY statements it documents", () => {
    // Sorted on both sides: declaration order in the policy document is a
    // readability choice, not a semantic one — DENY statements are unordered
    // in IAM evaluation.
    expect([...implementedSids(hcl)].sort()).toEqual([...documentedSids(hcl)]);
  });

  it("documents no statement it does not implement", () => {
    // Asserted separately from the equality above so a regression reports the
    // direction that broke. This is the direction the module regressed in:
    // the comment gained a fourth DENY, the code did not.
    expect(documentedSids(hcl).length).toBe(implementedSids(hcl).length);
  });

  it("gates the Object Lock mode on the IfExists form of the condition", () => {
    const statement = blockBody(hcl, 'data "aws_iam_policy_document" "bucket"').slice(
      blockBody(hcl, 'data "aws_iam_policy_document" "bucket"').indexOf(
        "DenyNonComplianceObjectLockMode"
      )
    );
    const condition = /test\s*=\s*"([^"]+)"\s*\n\s*variable\s*=\s*"s3:object-lock-mode"/.exec(
      statement
    );
    // A plain `StringNotEquals` here evaluates true when the key is absent,
    // which denies every header-less PUT — including the writers that
    // correctly inherit the bucket's COMPLIANCE default. Swapping the
    // operator reads like a tightening and would in fact break the archive's
    // own writers, so it is pinned.
    expect(condition?.[1]).toBe("StringNotEqualsIfExists");
  });

  it("requires COMPLIANCE mode and never permits GOVERNANCE", () => {
    const body = blockBody(hcl, 'data "aws_iam_policy_document" "bucket"');
    const statement = body.slice(body.indexOf("DenyNonComplianceObjectLockMode"));
    const values = /variable\s*=\s*"s3:object-lock-mode"\s*\n\s*values\s*=\s*\[([^\]]*)\]/.exec(
      statement
    );
    expect(values?.[1]).toContain("COMPLIANCE");
    expect(values?.[1]).not.toContain("GOVERNANCE");
  });

  it("refuses a retention window shorter than the HIPAA six-year floor", () => {
    const body = blockBody(hcl, 'data "aws_iam_policy_document" "bucket"');
    const statement = body.slice(body.indexOf("DenyShortObjectLockRetention"));
    const condition =
      /test\s*=\s*"([^"]+)"\s*\n\s*variable\s*=\s*"s3:object-lock-remaining-retention-days"/.exec(
        statement
      );
    // `IfExists` again: a PUT that sends no retain-until date leaves the key
    // unset and inherits the bucket default, which must stay allowed.
    expect(condition?.[1]).toBe("NumericLessThanIfExists");
  });
});
