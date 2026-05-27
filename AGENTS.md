# Pharmax Enterprise Pharmacy OS

This repository is for an enterprise-grade pharmacy operating system.

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
