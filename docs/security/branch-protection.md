# Branch protection — required configuration

This document is the authoritative description of the GitHub branch
protection rules that production deployments depend on. SOC 2 CC8.1
("Change management — authorized, reviewed, tested") requires that
no production change reach `main` without passing the documented
gates. The CI workflows in `.github/workflows/` produce the signals;
branch protection turns those signals into a merge gate.

Apply these rules to **the `main` branch only**. Feature branches do
not need protection; they may freely rebase, force-push, and break.

## How to apply

Set these via GitHub UI:

> Repository → Settings → Branches → Branch protection rules → Add rule

OR via the GitHub CLI (one-line, repeatable):

```bash
gh api -X PUT "repos/<owner>/<repo>/branches/main/protection" \
  --input docs/security/branch-protection.json
```

The companion `branch-protection.json` snapshot below captures the
intended state for both review and `gh api` replay. Update both
documents in the same PR if either changes.

## Required rules

### Pull request review

- **Require a pull request before merging.** No direct pushes to
  `main`. (`required_pull_request_reviews` non-null.)
- **Required approvals:** at least **1** approver. Two is
  preferred once headcount supports it; one is the minimum to keep
  the CC8.1 gate honest.
- **Dismiss stale pull request approvals when new commits are
  pushed.** A reviewer who approved an earlier commit has not
  reviewed the latest. (`dismiss_stale_reviews: true`.)
- **Require review from Code Owners.** The `.github/CODEOWNERS` file
  defines who must review security-critical paths. (`require_code_owner_reviews: true`.)
- **Restrict who can dismiss pull request reviews.** Limit to org
  admins. (`dismissal_restrictions` populated; empty allows anyone.)

### Required status checks

Branch protection must require ALL of the following checks before
merge. Each is a single aggregating job that all sub-jobs feed into,
so this list is stable across CI changes.

- `ci-pass` — produced by `.github/workflows/ci.yml`. Aggregates:
  `lint`, `format`, `typecheck`, `prisma-validate`, `safety-linters`,
  `test`.
- `security-pass` — produced by `.github/workflows/security.yml`.
  Aggregates: `codeql`, `gitleaks`, `dependency-review`, `sbom`.
- `integration` — produced by `.github/workflows/integration.yml`
  when the PR touches paths that opt the integration suite in
  (`prisma/**`, `packages/database/**`, ...). Required only when
  it runs; configure as **"Require branches to be up to date
  before merging"** so a stale PR that doesn't touch DB paths
  cannot evade the check by merging behind a sibling PR that did.

**Strict mode:** enable `Require branches to be up to date before
merging` so every CI run is on the actual merge candidate. Disabled
strict mode is the most common cause of "green PR → red main"
flakes.

### Conversation resolution

- **Require conversation resolution before merging.** Unresolved
  review threads must not be silently merged. (`required_conversation_resolution: true`.)

### Signed commits

- **Require signed commits.** SOC 2 evidence requires attribution
  of every change; GPG / SSH signatures provide that.
  (`required_signatures: true`.) Until every contributor has signing
  configured, this can be staged: enable for `main` first, then
  add `Require signed commits on all branches` once contributors
  have rotated.

### Linear history

- **Require linear history.** Forbids merge commits on `main`.
  Combined with `Squash and merge only` in the merge button
  settings, this produces a clean append-only history that the
  audit log can correlate against. (`required_linear_history: true`.)

### Push restrictions

- **Do not allow force pushes.** (`allow_force_pushes: false`.)
- **Do not allow deletions.** (`allow_deletions: false`.)
- **Restrict who can push to matching branches.** Even
  administrators should not push directly — keep the override
  reserved for "the CI configuration itself broke and someone
  needs to land the fix". Use `enforce_admins: true` to apply
  protection to admins too; flip to `false` only for the duration
  of a specific recovery and re-enable immediately.

## Repository-wide settings (apply once)

These live under Settings → General → Pull Requests:

- **Allow squash merging:** ON (default merge button).
- **Allow merge commits:** OFF (`required_linear_history` would
  block them anyway; turning off the button is the consistent
  signal).
- **Allow rebase merging:** OFF (we standardize on squash so each
  PR is one atomic commit on `main`).
- **Default to PR title for the squash commit:** ON.
- **Automatically delete head branches:** ON (housekeeping).

## Verifying

After applying, confirm via:

```bash
gh api "repos/<owner>/<repo>/branches/main/protection" \
  | jq '{
      reviews: .required_pull_request_reviews,
      checks: .required_status_checks.checks // .required_status_checks.contexts,
      linear: .required_linear_history.enabled,
      signed: .required_signatures.enabled,
      strict: .required_status_checks.strict,
      force_push: .allow_force_pushes.enabled,
      delete: .allow_deletions.enabled
    }'
```

Expected output:

```json
{
  "reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "checks": [
    { "context": "ci-pass" },
    { "context": "security-pass" },
    { "context": "integration" }
  ],
  "linear": true,
  "signed": true,
  "strict": true,
  "force_push": false,
  "delete": false
}
```

## Change history

Every change to this document or the corresponding GitHub setting
MUST be:

1. Reviewed in a PR (touching this file alone is sufficient).
2. Approved by `@pharmax/security`.
3. Reflected in the SOC 2 change-management evidence binder via the
   ops scaffolding (see `docs/security/control-matrix.md`).

A change to branch protection that bypasses CC8.1 review is itself
a CC8.1 finding.
