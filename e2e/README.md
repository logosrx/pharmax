# Pharmax E2E smoke suite

Playwright smoke tests that prove the operator console boots and the
critical operator paths work through a real browser. This is the
repo's first end-to-end layer — deliberately small, chromium-only,
and hermetic (throwaway database, synthetic data, no external
services).

## Run locally

```sh
pnpm db:up        # docker-compose Postgres (same one integration tests use)
pnpm test:e2e:install   # one-time: download the chromium browser
pnpm test:e2e
```

`pnpm test:e2e` does everything in order:

1. `e2e/setup.ts` creates the throwaway `pharmax_e2e` database (never
   the shared `pharmax` dev database), applies migrations, runs the
   standard demo seed (`prisma/seed.ts`), and seeds the synthetic E2E
   operator (`scripts/e2e-seed.ts`).
2. Playwright's `webServer` boots `apps/web` with `next dev` on port
   **3100** — the same way developers run the console — so the server
   takes the supported hermetic boot path (local KMS adapter from
   `PHARMAX_LOCAL_KMS_SEED`, in-memory package-photo storage, no
   AWS/S3/Sentry requirements). A production bundle is not usable
   here: `next build` bakes `NODE_ENV=production` into the server
   bundle, which switches `packages/database` to its mandatory RDS
   TLS path, and the local plaintext Postgres then rejects every
   connection (see the follow-ups below).
3. The tests run against `http://localhost:3100` (public surfaces)
   and `http://acme.localhost:3100` (tenant surfaces — sign-in
   resolves the org from the subdomain; Chromium maps `*.localhost`
   to loopback, no `/etc/hosts` entry needed).

View the HTML report after a run: `pnpm exec playwright show-report
e2e/playwright-report`.

### Environment

Everything is defined in `e2e/env.ts` — synthetic values only, no
secrets, no PHI:

| Variable           | Default                                                     | Purpose                          |
| ------------------ | ----------------------------------------------------------- | -------------------------------- |
| `E2E_DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/pharmax_e2e` | Throwaway database (overridable) |

The web app additionally receives `DATABASE_URL`, `DIRECT_URL`,
`PHARMAX_LOCAL_KMS_SEED` (32+ chars, synthetic), `APP_URL`, and
`LOG_LEVEL` from the same file.

## What's covered

- **Public surfaces** (`tests/public-smoke.spec.ts`)
  - `/api/health` returns 200 `ok`.
  - Unauthenticated `/` redirects to `/sign-in`; the sign-in form
    renders with zero browser console errors.
  - Protected API routes return 401 to sessionless callers.
- **Operator console** (`tests/operator-smoke.spec.ts`) — signs in as
  a seeded synthetic **Pharmacist** through the real
  `POST /api/auth/sign-in` path (no auth bypass; the role sits below
  the platform MFA floor, so password-only sign-in is the real
  policy, not a weakening of it):
  - Wrong password → enumeration-safe generic error.
  - Dashboard renders: greeting, stats, live workflow-pipeline queue
    counters (Typing / PV1 / Fill / Final), sidebar nav, order
    search bar.
  - ⌘K command palette opens, filters, and navigates.
  - Order search routes an unknown order to the graceful
    "Order not found" page.

## Documented follow-ups (deliberately deferred)

- **Smoke against the production bundle.** `next build` inlines
  `NODE_ENV=production` into the server bundle (webpack DefinePlugin),
  and `packages/database` keys its Postgres TLS toggle on that value —
  so a prod build unconditionally demands RDS TLS and cannot connect
  to the plaintext docker-compose Postgres (verified: every
  DB-touching request 500s with "server does not support SSL
  connections"). Unblocking this means either an SSL-enabled local
  Postgres in the harness or moving the TLS toggle to a runtime
  signal — a `packages/database` decision that belongs to its owners,
  not to this suite.
- **Workflow transition through the UI** (intake → typing → PV1 →
  fill → final → ship): needs an order fixture created through the
  real command path (prescription transcription requires patient +
  provider + product setup). The right shape is a dedicated fixture
  command-script that drives `executeCommand` — never raw status
  writes — and then a spec that clicks the actual queue surfaces.
- **MFA-floor roles** (OrgAdmin sign-in with TOTP enrollment) —
  needs a seeded TOTP secret and an otpauth code generator in the
  harness.
- **Cross-browser projects** (firefox/webkit) once chromium is
  stable in CI.
- **Making the CI job a required check** once flake rate is proven
  near zero.

## CI

`.github/workflows/e2e.yml` runs the suite on every PR in its own
workflow (separate from `ci.yml`, so it cannot block existing
required checks while it stabilizes). It provisions the same
Postgres 16 service container the integration workflow uses, caches
the Playwright browser download, and uploads the HTML report as an
artifact on failure.
