# 0001 — Record architectural decisions as ADRs

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** process, documentation

## Context

Pharmax has accumulated an unusually large surface of high-stakes
architectural decisions in its first build phases: Postgres row-level
security as the tenancy boundary, envelope encryption per PHI field,
a hash-chained audit log, a twenty-step command-bus contract, a
declarative `defineCommand` factory, ports-and-adapters for Stripe and
shipping carriers, Clerk-for-auth-only, and more. Every one of these
calls had multiple credible alternatives and non-trivial trade-offs.

Today, the rationale for these decisions lives as prose inside
`docs/IMPLEMENTATION_PLAN.md`. The plan is excellent for tracking
**what** was built and in what order, but it is the wrong shape for
answering **why** the team chose X over Y. New engineers, auditors,
SOC 2 reviewers, and future AI agents working on this codebase keep
asking the same questions ("why blind indexes instead of searchable
encryption?", "why DB-polled outbox instead of BullMQ?") and the
answers are buried inside multi-thousand-character bullet points
that were not written for that audience.

We need a durable, discoverable, decision-shaped artifact.

## Decision

Adopt **Michael Nygard-style Architecture Decision Records**, stored
in `docs/adr/`, one Markdown file per decision, numbered sequentially
(`0001`, `0002`, ...), and never renumbered.

Each ADR carries a status (`Proposed`, `Accepted`, `Superseded by
NNNN`, `Deprecated`) and a fixed set of sections: Context, Decision,
Consequences, References, and optional Alternatives Considered. The
canonical template lives at `docs/adr/template.md`. The series rules
(numbering, lifecycle, naming, authoring workflow) live at
`docs/adr/README.md`.

The first action under this practice is to **backfill ADRs for the
significant decisions already made** during phases 0 through 5, so
the historical record exists before new decisions accumulate on top
of it.

## Consequences

**Easier:**

- Onboarding a new engineer or AI agent: read the ADR series in order
  and you have the same mental model as the team.
- Compliance and audit conversations: each SOC 2 control claim points
  to a specific ADR rather than to "somewhere in this 7000-word plan".
- PR review for cross-cutting changes: reviewers can ask "which ADR
  authorises this?" and either point at one, raise a new ADR, or
  reject the change.

**Harder:**

- Every significant decision now requires a short writing step. Teams
  that skip it will accumulate the same problem we are solving today.
- ADRs must be kept honest. A superseded decision must be marked
  `Superseded by NNNN` rather than silently mutated; the historical
  body stays for context.

**Ongoing obligations:**

- The `IMPLEMENTATION_PLAN.md` build-order ledger continues to exist,
  but stops being the home of architectural rationale. New entries
  should cite the relevant ADR by number rather than restate it.
- The ADR series and the plan are kept in sync at PR time, not as a
  separate cleanup pass.

## Alternatives Considered

- **Keep rationale inside `IMPLEMENTATION_PLAN.md`.** This is the
  current state. It fails the discoverability test (the plan is
  build-ordered, not topic-ordered) and the granularity test (each
  bullet is a slice of work, not a decision).
- **A wiki or Notion page per decision.** Loses git history,
  loses inline code review, and lives outside the repo so AI agents
  and CI cannot reference it directly.
- **A single `DECISIONS.md` file.** Becomes the same problem
  `IMPLEMENTATION_PLAN.md` already has — prose buried inside a long
  document, with no per-decision lifecycle.

## References

- Michael Nygard, "Documenting Architecture Decisions" (2011)
- `docs/adr/README.md` — process documentation for this series
- `docs/adr/template.md` — copy-pasta template
- `docs/IMPLEMENTATION_PLAN.md` — the build-order ledger this series complements
