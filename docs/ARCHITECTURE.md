# Pharmax Architecture

Pharmax is an enterprise pharmacy operating system.

Architecture:

- Frontend: Next.js, React, TypeScript, Tailwind
- Backend: command-driven TypeScript service architecture
- Database: PostgreSQL with Prisma
- Queues/cache: Redis or Valkey
- Files: S3-compatible storage
- Workers: background jobs for print, shipping, SLA timers, notifications, reporting
- Hardware: Zebra printing with ZPL and barcode scanners
- Shipping: EasyPost-style adapter
- Security: HIPAA-aware, SOC 2-ready controls

Core workflow:

Received → Typing → PV1 → Filling → Final Verification → Ready to Ship → Shipped

Critical state changes must go through command handlers with idempotency, row locking, audit logs, order events, command logs, and event outbox records.
