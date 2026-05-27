# NNNN — Short, declarative title

- **Status:** Proposed | Accepted | Superseded by NNNN | Deprecated
- **Date:** YYYY-MM-DD
- **Deciders:** Names or roles (e.g. Platform team, Pharmacy ops lead)
- **Tags:** Optional comma-separated labels (e.g. `security`, `data`, `workflow`)

## Context

What problem are we solving? What forces are in play — technical, regulatory,
operational, financial? What constraints already exist (decisions in earlier
ADRs, schema shape, third-party contracts)? Keep this section focused on the
_situation_; do not pre-litigate the decision yet.

A reader who has never seen this codebase should be able to understand, from
this section alone, why a decision was even needed.

## Decision

In **one or two declarative sentences**, state the decision. Then expand:
what does this commit us to in code, schema, process, or interface? Be
specific enough that a reviewer can tell whether a future PR is faithful
to the ADR or contradicts it.

If the decision has multiple parts (e.g. "use X _and_ enforce it via Y"),
list them as bullets.

## Consequences

What becomes **easier** because of this decision?
What becomes **harder** or more expensive?
What ongoing obligations does the team take on (e.g. "every new migration
must be paired with an RLS policy")?
What failure modes does this decision create, and how do we detect them?

Be candid. ADRs that only list upsides are not useful for the engineer
who has to live with the downsides three years later.

## Alternatives Considered (optional)

For each rejected option, state:

- **What** the alternative was (in concrete terms).
- **Why** it was attractive.
- **Why** we rejected it — usually one or two specific failure modes or
  costs that the chosen option avoids.

Include this section whenever the rejected options would be a reasonable
guess for a future reader who didn't sit in the room.

## References

- Code: `path/to/relevant/file.ts`
- Migrations: `prisma/migrations/YYYYMMDDHHMMSS_name/`
- Companion ADRs: `0NNN-related-decision.md`
- External: links to RFCs, papers, vendor docs, or compliance citations
- Implementation plan: `docs/IMPLEMENTATION_PLAN.md` (Phase N, item title)
