# Architecture Decision Records

This directory holds the **Architecture Decision Records (ADRs)** for Pharmax.
An ADR captures a single significant architectural decision: the context that
forced the call, the option chosen, the alternatives rejected, and the
consequences the team has agreed to live with.

ADRs answer **why** Pharmax is built the way it is. They do not replace
runtime documentation (see `RUNBOOK.md`), operational playbooks
(`INCIDENT_RESPONSE.md`), or the build-order ledger (`IMPLEMENTATION_PLAN.md`).
They are the canonical reference that new engineers, auditors, and future
reviewers reach for when they ask "why did we choose this?".

## Relationship to other documents

| Document                          | Role                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `docs/IMPLEMENTATION_PLAN.md`     | **What** has been built, in what order, and what is still pending. Build-order ledger. |
| `docs/ARCHITECTURE_PRINCIPLES.md` | **How** to apply the durable engineering principles (multipliers, upgrades).           |
| `docs/ARCHITECTURE.md`            | Snapshot diagram of the system at the highest level.                                   |
| `docs/adr/NNNN-*.md`              | **Why** a specific decision was made. One file per decision.                           |
| `docs/RUNBOOK.md`                 | How to operate the running system.                                                     |

If you find yourself documenting _why_ inside `IMPLEMENTATION_PLAN.md`, stop —
that prose belongs in an ADR. The plan should cite the ADR by number.

## When to write an ADR

Write a new ADR whenever the team makes a decision that:

- Is **hard to reverse** once code or data depends on it (schema shape,
  encryption boundaries, command-bus contract, tenancy enforcement layer).
- Has **multiple credible alternatives** with non-trivial trade-offs.
- Spans **multiple packages, services, or runtime tiers** so a single PR
  description cannot reasonably hold the rationale.
- Touches **safety, compliance, or auditability** (PHI handling, RBAC,
  workflow safety, audit chain).
- Changes a **public contract** that other teams or future agents will rely
  on (command shape, event shape, port interface).

You do **not** need an ADR for routine code, additive features that fit an
existing pattern (e.g. adding the seventeenth verification command — the ADR
for the command-bus contract already covers it), or reversible refactors that
stay inside a single package.

If you are unsure, write the ADR. ADRs are cheap; archaeology is not.

## Numbering rules

- ADRs are numbered **sequentially**, four digits, zero-padded:
  `0001`, `0002`, ... `0017`.
- Numbers are **assigned once and never reused**. If an ADR is superseded
  or deprecated, its file stays where it is with an updated `Status` line
  and a pointer to its replacement.
- **Never renumber**. Tools, code comments, and other ADRs may already cite
  a number; renumbering breaks every back-reference.
- Some numbers are **reserved** for in-progress decisions owned by other
  agents (see `0016-0022` in this directory). A reserved stub claims the
  number; only the owning agent should edit the file body.

To pick the next number, run `ls docs/adr/*.md | sort` and pick one above
the highest. Two agents writing ADRs in parallel must coordinate (or the
later one renames their file before merge).

## File naming

```
NNNN-kebab-case-title.md
```

The title is a short, declarative phrase — the same one that appears on
the first line of the file. Examples:

- `0004-multi-tenancy-via-postgres-rls.md`
- `0007-command-bus-twenty-step-contract.md`

## Lifecycle

Every ADR has a `Status` field at the top. The legal values:

| Status               | Meaning                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `Proposed`           | Drafted but not yet ratified. Implementation has not started, or is gated on review.            |
| `Accepted`           | Ratified. Code reflects the decision. New contributors must follow it.                          |
| `Superseded by NNNN` | Replaced by a later ADR. The body stays for historical context; new work follows the successor. |
| `Deprecated`         | The decision is no longer in force, but no replacement ADR exists yet.                          |

Promotion happens by editing the `Status` line in a PR. The PR description
should reference the discussion that drove the change.

## Authoring

1. Copy `template.md` to `NNNN-your-title.md`.
2. Fill in **Context** (what problem are we solving, what constraints applied),
   **Decision** (the option chosen, in active voice), **Consequences**
   (what becomes easier, what becomes harder, what we accept as the cost),
   and **References** (links to code, migrations, other ADRs).
3. Use the optional **Alternatives Considered** section when the rejected
   options matter to a future reader — they almost always do.
4. Keep each ADR roughly **300–700 words**. Longer than that usually means
   it is two decisions in one file; split it.
5. Cross-link related ADRs. If 0007 builds on 0004, say so explicitly in
   both directions.
6. Open the PR. Tag the relevant code owners. Merge when the team agrees
   the rationale is faithfully captured.

## How to read this series

If you are new to the codebase, read the ADRs in numeric order — they were
written so that earlier decisions ground later ones. The meta-ADR `0001`
establishes why we keep them at all; everything else assumes you have read
it.
