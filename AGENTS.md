# Pharmax Enterprise Pharmacy OS

This repository is for an enterprise-grade pharmacy operating system.

## Start every session in its own worktree

Run this once, before you edit anything:

```
pnpm session:new <branch-name>     # e.g. pnpm session:new feat/provider-portal
cd ../Pharmax-<name>
```

More than one agent session runs against this repository at a time. If
two of them share a checkout, two things break that no amount of commit
discipline can fix:

- **Nobody commits.** When several sessions edit one tree, no session
  can tell which changes are its own, and committing would sweep up
  someone else's half-finished work. That is how 211 uncommitted files
  once accumulated here, and the split that followed silently dropped
  work that took weeks to notice.
- **A branch switch relocates everyone.** `git switch` carries every
  uncommitted change in the tree with it, including other sessions',
  landing work on a branch nobody meant to put it on.

Keep the primary checkout on `main`. Commits to `main` are refused by
`.husky/pre-commit`; land everything through a PR. If the reporter warns
that your checkout changed branch and it was not you, stop and move to
your own worktree before doing anything else.

Before editing, follow the rules in:

- .cursor/rules/00-project-overview.mdc
- .cursor/rules/01-workflow-safety.mdc
- .cursor/rules/02-security-compliance.mdc
- .cursor/rules/03-sla-performance.mdc
- .cursor/rules/04-clean-room-policy.mdc

Critical rules:

- Never mutate pharmacy workflow state directly.
- All critical workflow mutations must go through command handlers.
- Every critical command requires idempotency.
- Every critical transition must write command_log, order_event, audit_log, and event_outbox.
- No fill before PV1.
- No final verification before fill completion.
- No ship before final verification.
- No PHI in logs.
- No unscoped clinic data access.
- No ingestion of competing pharmacy products' source, JS bundles, network traces, or session-gated material. Design inputs come from docs/governance/public-sources-reference.md only.
