#!/usr/bin/env tsx
// scripts/security/access-review/infrastructure-access.ts
//
// Infrastructure access review report generator.
//
// Enumerates the privileged access that exists outside the application's
// own RBAC tables — AWS IAM principals, KMS key administrators, and
// GitHub repository access — and emits a CSV the reviewer walks row by
// row per the access review procedure §5.2.
//
// WHY THIS EXISTS SEPARATELY FROM run-access-review.ts
//
// `run-access-review.ts` reads the `User` and `UserRole` tables for one
// organization. That is the right report once tenants exist. It is not
// the report that matters before they do: with zero organizations it
// returns nothing, while the access that can actually reach the
// production database, the KMS keys wrapping every tenant DEK, and the
// deploy pipeline is entirely outside those tables. Reviewing only
// application RBAC would review the empty surface and skip the full one.
//
// The two reports are complements, not alternatives. Once tenants exist
// both run each quarter.
//
// A NOTE ON PARTIAL COLLECTION
//
// When a source cannot be read the script does NOT silently omit it. It
// emits a row with `principal = *** COLLECTION FAILED ***` carrying the
// error, and exits non-zero. A compliance artifact that is quietly
// missing a section is worse than one that is obviously broken, because
// the reviewer signs the first and fixes the second. The whole point of
// the walk is that every row gets a decision; a section that never
// appears never gets one.
//
// Usage:
//   pnpm tsx scripts/security/access-review/infrastructure-access.ts \
//     [--profile=pharmax-prod] \
//     [--repo=owner/name] \
//     [--out-dir=evidence/access-reviews/<YYYY-Q#>] \
//     [--skip-aws] [--skip-github] [--stdout]
//
// Requires: the `aws` CLI authenticated for --profile, and `gh`
// authenticated for --repo. Both are read-only calls.
//
// Exits:
//   0  every requested source collected, CSV written.
//   1  at least one source failed (CSV still written, failures included).

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const USAGE = `
Usage: pnpm tsx scripts/security/access-review/infrastructure-access.ts \\
  [--profile=pharmax-prod] [--repo=owner/name] \\
  [--out-dir=evidence/access-reviews/<YYYY-Q#>] \\
  [--skip-aws] [--skip-github] [--stdout]
`.trim();

const COLLECTION_FAILED = "*** COLLECTION FAILED ***";

/** Access keys older than this are called out as a finding in `notes`. */
const ACCESS_KEY_AGE_WARN_DAYS = 90;

/** Principals with no recorded activity in this window are flagged. */
const INACTIVITY_WARN_DAYS = 90;

interface ReviewRow {
  readonly source: string;
  readonly principal: string;
  readonly displayName: string;
  readonly access: string;
  readonly scope: string;
  readonly lastActivity: string;
  readonly granted: string;
  readonly notes: string;
}

interface ParsedArgs {
  readonly profile: string;
  readonly repo: string;
  readonly outDir?: string;
  readonly skipAws: boolean;
  readonly skipGithub: boolean;
  readonly toStdout: boolean;
}

function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      profile: { type: "string", default: "pharmax-prod" },
      repo: { type: "string", default: "logosrx/pharmax" },
      "out-dir": { type: "string" },
      "skip-aws": { type: "boolean", default: false },
      "skip-github": { type: "boolean", default: false },
      stdout: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  return {
    profile: values.profile ?? "pharmax-prod",
    repo: values.repo ?? "logosrx/pharmax",
    ...(typeof values["out-dir"] === "string" ? { outDir: values["out-dir"] } : {}),
    skipAws: values["skip-aws"] === true,
    skipGithub: values["skip-github"] === true,
    toStdout: values.stdout === true,
  };
}

function currentQuarterLabel(now: Date): string {
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

async function runJson<T>(command: string, args: ReadonlyArray<string>): Promise<T> {
  // maxBuffer raised because IAM policy documents and KMS key policies
  // are verbose and the default 1MB truncates them mid-JSON, which
  // surfaces as an unhelpful parse error rather than as a size problem.
  const { stdout } = await execFileAsync(command, [...args], { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

function failureRow(source: string, cause: unknown): ReviewRow {
  return {
    source,
    principal: COLLECTION_FAILED,
    displayName: "",
    access: "",
    scope: "",
    lastActivity: "",
    granted: "",
    notes: `Could not read this source: ${cause instanceof Error ? cause.message : String(cause)}`,
  };
}

// ---------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------

interface IamUser {
  readonly UserName: string;
  readonly Arn: string;
  readonly CreateDate: string;
  readonly PasswordLastUsed?: string;
}

interface AccessKeyMetadata {
  readonly AccessKeyId: string;
  readonly Status: string;
  readonly CreateDate: string;
}

async function collectAwsUsers(profile: string, now: Date): Promise<ReviewRow[]> {
  const rows: ReviewRow[] = [];

  const { Users } = await runJson<{ Users: IamUser[] }>("aws", [
    "iam",
    "list-users",
    "--profile",
    profile,
    "--output",
    "json",
  ]);

  for (const user of Users) {
    const [keys, mfa, attached, inline] = await Promise.all([
      runJson<{ AccessKeyMetadata: AccessKeyMetadata[] }>("aws", [
        "iam",
        "list-access-keys",
        "--user-name",
        user.UserName,
        "--profile",
        profile,
        "--output",
        "json",
      ]),
      runJson<{ MFADevices: ReadonlyArray<{ SerialNumber: string }> }>("aws", [
        "iam",
        "list-mfa-devices",
        "--user-name",
        user.UserName,
        "--profile",
        profile,
        "--output",
        "json",
      ]),
      runJson<{ AttachedPolicies: ReadonlyArray<{ PolicyName: string }> }>("aws", [
        "iam",
        "list-attached-user-policies",
        "--user-name",
        user.UserName,
        "--profile",
        profile,
        "--output",
        "json",
      ]),
      runJson<{ PolicyNames: ReadonlyArray<string> }>("aws", [
        "iam",
        "list-user-policies",
        "--user-name",
        user.UserName,
        "--profile",
        profile,
        "--output",
        "json",
      ]),
    ]);

    const policyNames = [
      ...attached.AttachedPolicies.map((p) => p.PolicyName),
      ...inline.PolicyNames.map((p) => `${p} (inline)`),
    ];

    const findings: string[] = [];
    if (mfa.MFADevices.length === 0) {
      findings.push("NO MFA");
    }
    for (const key of keys.AccessKeyMetadata) {
      const age = daysSince(key.CreateDate, now);
      if (key.Status === "Active" && age !== null && age > ACCESS_KEY_AGE_WARN_DAYS) {
        findings.push(`access key ${key.AccessKeyId} active and ${String(age)}d old`);
      }
    }
    if (policyNames.some((p) => p.toLowerCase().includes("administrator"))) {
      findings.push("administrator policy attached");
    }
    const idleDays = daysSince(user.PasswordLastUsed, now);
    if (idleDays !== null && idleDays > INACTIVITY_WARN_DAYS) {
      findings.push(`console unused ${String(idleDays)}d`);
    }

    rows.push({
      source: "aws-iam-user",
      principal: user.Arn,
      displayName: user.UserName,
      access: policyNames.length > 0 ? policyNames.join("; ") : "(no policies attached)",
      scope: "aws-account",
      lastActivity: user.PasswordLastUsed ?? "(never signed in to console)",
      granted: user.CreateDate,
      notes: findings.join("; "),
    });
  }

  return rows;
}

async function collectAwsAccountPosture(profile: string): Promise<ReviewRow[]> {
  const summary = await runJson<{ SummaryMap: Record<string, number> }>("aws", [
    "iam",
    "get-account-summary",
    "--profile",
    profile,
    "--output",
    "json",
  ]);

  const rootMfa = summary.SummaryMap["AccountMFAEnabled"] === 1;

  return [
    {
      source: "aws-account-root",
      principal: "root",
      displayName: "AWS account root user",
      access: "unrestricted",
      scope: "aws-account",
      lastActivity: "(not exposed by get-account-summary; check the credential report)",
      granted: "(account creation)",
      // Root without MFA is the single highest-severity finding this
      // report can produce, so it is stated as a finding rather than
      // left for the reviewer to infer from a boolean column.
      notes: rootMfa
        ? "Root MFA enabled"
        : "ROOT MFA NOT ENABLED — treat as an immediate corrective, not a review item",
    },
  ];
}

/**
 * Human access to an AWS account frequently arrives through IAM Identity
 * Center rather than through IAM users, in which case `list-users`
 * returns an empty set and the account looks unpopulated while real
 * people sign in every day. Enumerating Identity Center is what makes
 * "zero IAM users" a finding of fact rather than an artifact of looking
 * in one place.
 */
async function collectSsoAssignments(profile: string): Promise<ReviewRow[]> {
  const rows: ReviewRow[] = [];

  const { Instances } = await runJson<{
    Instances: ReadonlyArray<{ readonly InstanceArn: string; readonly IdentityStoreId: string }>;
  }>("aws", ["sso-admin", "list-instances", "--profile", profile, "--output", "json"]);

  if (Instances.length === 0) {
    rows.push({
      source: "aws-sso",
      principal: "(no Identity Center instance)",
      displayName: "AWS IAM Identity Center",
      access: "n/a",
      scope: "aws-account",
      lastActivity: "",
      granted: "",
      notes:
        "No Identity Center instance in this region. Combined with zero IAM users this means " +
        "human access arrives by another path — confirm which, and review it.",
    });
    return rows;
  }

  for (const instance of Instances) {
    let PermissionSets: ReadonlyArray<string>;
    try {
      ({ PermissionSets } = await runJson<{ PermissionSets: ReadonlyArray<string> }>("aws", [
        "sso-admin",
        "list-permission-sets",
        "--instance-arn",
        instance.InstanceArn,
        "--profile",
        profile,
        "--output",
        "json",
      ]));
    } catch (cause) {
      // Identity Center is administered from the Organizations
      // management account, so a member-account credential can see that
      // an instance exists but cannot enumerate its permission sets.
      // That is a healthy separation and not an error to fix here — but
      // it does mean the humans with access are enumerable only from the
      // management account, and a review run solely against this account
      // has not covered them.
      const message = cause instanceof Error ? cause.message : String(cause);
      const isAccessDenied = message.includes("AccessDenied");
      rows.push({
        source: "aws-sso-permission-set",
        principal: isAccessDenied ? "(not enumerable from this account)" : COLLECTION_FAILED,
        displayName: `Identity Center instance ${instance.InstanceArn}`,
        access: "Identity Center permission sets",
        scope: instance.InstanceArn,
        lastActivity: "",
        granted: "",
        notes: isAccessDenied
          ? "This account can see the Identity Center instance but not its permission sets, " +
            "which means Identity Center is administered from the Organizations management " +
            "account. Human AWS access is assigned there. Re-run this script with a " +
            "management-account profile, or enumerate users, groups and account assignments " +
            "in the Identity Center console, and record each as a decision row. Reviewing " +
            "only this account leaves every human principal unreviewed."
          : `Could not read permission sets: ${message}`,
      });
      continue;
    }

    for (const permissionSetArn of PermissionSets) {
      const described = await runJson<{
        PermissionSet: { readonly Name: string; readonly CreatedDate: string };
      }>("aws", [
        "sso-admin",
        "describe-permission-set",
        "--instance-arn",
        instance.InstanceArn,
        "--permission-set-arn",
        permissionSetArn,
        "--profile",
        profile,
        "--output",
        "json",
      ]);

      rows.push({
        source: "aws-sso-permission-set",
        principal: permissionSetArn,
        displayName: described.PermissionSet.Name,
        access: "Identity Center permission set",
        scope: instance.InstanceArn,
        lastActivity: "(use CloudTrail for assumption events)",
        granted: described.PermissionSet.CreatedDate,
        notes:
          "Enumerate the assigned users or groups in the Identity Center console " +
          "and record each as a decision row.",
      });
    }
  }

  return rows;
}

interface KmsKeyListing {
  readonly KeyId: string;
  readonly KeyArn: string;
}

async function collectKmsAdministrators(profile: string, accountId: string): Promise<ReviewRow[]> {
  const rows: ReviewRow[] = [];

  const { Keys } = await runJson<{ Keys: KmsKeyListing[] }>("aws", [
    "kms",
    "list-keys",
    "--profile",
    profile,
    "--output",
    "json",
  ]);

  for (const key of Keys) {
    const described = await runJson<{
      KeyMetadata: {
        readonly KeyId: string;
        readonly Description: string;
        readonly KeyManager: string;
        readonly Enabled: boolean;
        readonly CreationDate: string;
      };
    }>("aws", [
      "kms",
      "describe-key",
      "--key-id",
      key.KeyId,
      "--profile",
      profile,
      "--output",
      "json",
    ]);

    // AWS-managed keys have policies we cannot change and principals we
    // do not grant, so listing them adds rows the reviewer cannot act
    // on. Customer-managed keys are the ones holding tenant KEK
    // material and are the point of this section.
    if (described.KeyMetadata.KeyManager !== "CUSTOMER") continue;

    const policy = await runJson<{ Policy: string }>("aws", [
      "kms",
      "get-key-policy",
      "--key-id",
      key.KeyId,
      "--policy-name",
      "default",
      "--profile",
      profile,
      "--output",
      "json",
    ]);

    const parsed = JSON.parse(policy.Policy) as {
      readonly Statement: ReadonlyArray<{
        readonly Sid?: string;
        readonly Effect: string;
        readonly Principal?: { readonly AWS?: string | ReadonlyArray<string> };
        readonly Action?: string | ReadonlyArray<string>;
      }>;
    };

    const principals = new Set<string>();
    for (const statement of parsed.Statement) {
      if (statement.Effect !== "Allow") continue;
      const principalRaw = statement.Principal?.AWS;
      if (principalRaw === undefined) continue;
      for (const principal of Array.isArray(principalRaw) ? principalRaw : [principalRaw]) {
        principals.add(principal);
      }
    }

    // `arn:aws:iam::<account>:root` in a key policy is AWS's idiom for
    // "defer to IAM in this account". It is not a grant to the root
    // user, and it appears in every key created from the default policy.
    // Flagging it as a crypto-shred path puts an identical alarming note
    // on every row, which is how a report teaches its reader to skim.
    // The finding worth surfacing is a principal named *in addition* to
    // that delegation.
    const iamDelegation = `arn:aws:iam::${accountId}:root`;
    const explicit = [...principals].filter((p) => p !== iamDelegation);

    rows.push({
      source: "aws-kms-key",
      principal: explicit.length > 0 ? explicit.join("; ") : iamDelegation,
      displayName: described.KeyMetadata.Description || key.KeyId,
      access:
        explicit.length > 0
          ? "IAM delegation plus explicit key-policy principals"
          : "IAM delegation only (default key policy)",
      scope: key.KeyArn,
      lastActivity: "(use CloudTrail for key usage)",
      granted: described.KeyMetadata.CreationDate,
      notes: [
        explicit.length > 0
          ? `Key policy names ${String(explicit.length)} principal(s) beyond IAM delegation — confirm each is intended`
          : "",
        described.KeyMetadata.Enabled ? "" : "Key is DISABLED",
      ]
        .filter((n) => n.length > 0)
        .join("; "),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------

async function collectGithubAccess(repo: string, now: Date): Promise<ReviewRow[]> {
  const rows: ReviewRow[] = [];

  const collaborators = await runJson<
    ReadonlyArray<{
      readonly login: string;
      readonly role_name: string;
      readonly permissions: Record<string, boolean>;
    }>
  >("gh", ["api", `repos/${repo}/collaborators`, "--paginate"]);

  for (const collaborator of collaborators) {
    const granted = Object.entries(collaborator.permissions)
      .filter(([, held]) => held)
      .map(([name]) => name)
      .join("; ");
    rows.push({
      source: "github-collaborator",
      principal: collaborator.login,
      displayName: collaborator.login,
      access: `${collaborator.role_name} (${granted})`,
      scope: repo,
      lastActivity: "(not exposed by the collaborators API)",
      granted: "(not exposed by the collaborators API)",
      notes: collaborator.role_name === "admin" ? "Repository admin" : "",
    });
  }

  const deployKeys = await runJson<
    ReadonlyArray<{
      readonly id: number;
      readonly title: string;
      readonly created_at: string;
      readonly read_only: boolean;
      readonly last_used?: string | null;
    }>
  >("gh", ["api", `repos/${repo}/keys`, "--paginate"]);

  for (const deployKey of deployKeys) {
    const age = daysSince(deployKey.created_at, now);
    rows.push({
      source: "github-deploy-key",
      principal: `deploy-key:${String(deployKey.id)}`,
      displayName: deployKey.title,
      access: deployKey.read_only ? "read-only" : "READ-WRITE",
      scope: repo,
      lastActivity: deployKey.last_used ?? "(never used)",
      granted: deployKey.created_at,
      notes: [
        deployKey.read_only ? "" : "Write-capable deploy key",
        age !== null && age > 365 ? `${String(age)}d old` : "",
      ]
        .filter((n) => n.length > 0)
        .join("; "),
    });
  }

  // The production environment's reviewer list is an access control in
  // its own right: it is the set of people who can approve a deploy to
  // the environment that holds PHI.
  try {
    const environment = await runJson<{
      readonly protection_rules?: ReadonlyArray<{
        readonly type: string;
        readonly reviewers?: ReadonlyArray<{
          readonly type: string;
          readonly reviewer: { readonly login?: string; readonly slug?: string };
        }>;
      }>;
    }>("gh", ["api", `repos/${repo}/environments/production`]);

    const reviewerRules = environment.protection_rules?.filter(
      (rule) => rule.type === "required_reviewers"
    );
    const reviewers = reviewerRules?.flatMap((rule) => rule.reviewers ?? []) ?? [];

    if (reviewers.length === 0) {
      rows.push({
        source: "github-environment",
        principal: "(none)",
        displayName: "production environment reviewers",
        access: "deploy approval",
        scope: `${repo}:production`,
        lastActivity: "",
        granted: "",
        notes: "No required reviewers configured — deploys to production are unapproved",
      });
    }
    for (const reviewer of reviewers) {
      rows.push({
        source: "github-environment",
        principal: reviewer.reviewer.login ?? reviewer.reviewer.slug ?? "(unknown)",
        displayName: "production environment reviewer",
        access: "deploy approval",
        scope: `${repo}:production`,
        lastActivity: "",
        granted: "",
        notes: "Can approve a production deploy",
      });
    }
  } catch (cause) {
    rows.push(failureRow("github-environment", cause));
  }

  return rows;
}

// ---------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function toCsv(rows: ReadonlyArray<ReviewRow>): string {
  // `decision` and `decision_reason` ship empty on purpose. The report
  // is not the control — the walk is. Procedure §5.2: a row with no
  // decision recorded is itself a finding, which only works if the
  // column is present and visibly blank.
  const header = [
    "source",
    "principal",
    "display_name",
    "access",
    "scope",
    "last_activity",
    "granted",
    "notes",
    "decision",
    "decision_reason",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.source,
        row.principal,
        row.displayName,
        row.access,
        row.scope,
        row.lastActivity,
        row.granted,
        row.notes,
        "",
        "",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const now = new Date();
  const rows: ReviewRow[] = [];
  let failed = false;

  if (!args.skipAws) {
    let accountId = "";
    try {
      const identity = await runJson<{ Account: string }>("aws", [
        "sts",
        "get-caller-identity",
        "--profile",
        args.profile,
        "--output",
        "json",
      ]);
      accountId = identity.Account;
    } catch (cause) {
      rows.push(failureRow("aws-identity", cause));
      failed = true;
    }

    for (const [label, collect] of [
      ["aws-account-root", () => collectAwsAccountPosture(args.profile)],
      ["aws-iam-user", () => collectAwsUsers(args.profile, now)],
      ["aws-sso", () => collectSsoAssignments(args.profile)],
      ["aws-kms-key", () => collectKmsAdministrators(args.profile, accountId)],
    ] as const) {
      try {
        const collected = await collect();
        // An empty section is ambiguous — it means either "nothing is
        // granted here" or "this is not where the access lives". The
        // reviewer cannot tell those apart from a blank space, so say
        // which one it is and make them sign for it either way.
        if (collected.length === 0) {
          rows.push({
            source: label,
            principal: "(none found)",
            displayName: "",
            access: "",
            scope: "aws-account",
            lastActivity: "",
            granted: "",
            notes:
              "Source read successfully and returned no principals. Confirm this means none " +
              "exist rather than that access to this surface arrives another way.",
          });
        }
        rows.push(...collected);
      } catch (cause) {
        rows.push(failureRow(label, cause));
        failed = true;
      }
    }
  }

  if (!args.skipGithub) {
    try {
      rows.push(...(await collectGithubAccess(args.repo, now)));
    } catch (cause) {
      rows.push(failureRow("github", cause));
      failed = true;
    }
  }

  const csv = toCsv(rows);

  if (args.toStdout) {
    process.stdout.write(csv);
  } else {
    const outDir =
      args.outDir ?? resolve(process.cwd(), "evidence", "access-reviews", currentQuarterLabel(now));
    const outPath = resolve(outDir, "infrastructure-access.csv");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, csv, "utf8");
    process.stdout.write(`${outPath}\n`);
  }

  const findings = rows.filter((r) => r.notes.length > 0 && r.principal !== COLLECTION_FAILED);
  process.stderr.write(
    `\n${String(rows.length)} principals across ${String(new Set(rows.map((r) => r.source)).size)} sources. ` +
      `${String(findings.length)} carry a note to resolve during the walk.\n`
  );
  if (failed) {
    process.stderr.write(
      `\nAt least one source could not be read; those rows are marked ${COLLECTION_FAILED} ` +
        `in the CSV. Resolve them before signing — an unread source is an unreviewed one.\n`
    );
  }

  process.exit(failed ? 1 : 0);
}

main().catch((cause: unknown) => {
  process.stderr.write(`\nFATAL: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
