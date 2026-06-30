# syntax=docker/dockerfile:1.7
# =============================================================================
# Next.js web/API service (apps/web) — production container image.
#
# IMPORTANT: build context MUST be the repo root, because this is a pnpm
# workspace and the build needs the lockfile, the Prisma schema, and every
# @pharmax/* workspace package:
#
#   docker build -f apps/web/Dockerfile -t pharmax/web .
#
# The image is produced from Next's `output: "standalone"` bundle (see
# apps/web/next.config.mjs). The runner stage carries only the traced
# server + static assets, not the full monorepo node_modules.
# =============================================================================

# ---- Base: pinned Node + pnpm via corepack ---------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---- Builder: install deps, generate Prisma client, build standalone -------
FROM base AS builder
# OpenSSL is required by Prisma's query engine at `prisma generate` time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy the whole monorepo. .dockerignore strips node_modules/.next/etc.
COPY . .

# Install ALL workspace deps from the frozen lockfile. The root
# `postinstall` runs `pnpm db:generate`, emitting the Prisma client into
# packages/database/src/generated.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

# Build the web app. SENTRY_AUTH_TOKEN is intentionally absent here, so
# source-map upload is skipped (the rest of the Sentry integration still
# compiles). Output lands in apps/web/.next/standalone.
#
# DATABASE_URL is the one required (no-default) entry in the apps/web env
# schema, and Next's "Collecting page data" phase imports route modules
# (which transitively import the server env loader), so a value must be
# present at BUILD time. It is a SERVER-only var — never inlined into any
# client bundle and never read from this build value at runtime — so a
# throwaway placeholder is safe here. The real connection string is
# injected by the ECS task definition from Secrets Manager at runtime.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
RUN pnpm --filter pharmacy-os build

# ---- Runner: minimal standalone runtime ------------------------------------
FROM base AS runner
ENV NODE_ENV=production
# `openssl` is the Prisma query-engine runtime dependency; `wget` powers
# the ECS container health check (infra/terraform/modules/ecs/main.tf).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

# Amazon RDS global CA bundle. Prisma 7's `pg` driver does verify-full TLS
# (sslmode=require is treated as verify-full by pg-connection-string >= 2.x),
# so node must trust the RDS chain. The ECS task sets
# NODE_EXTRA_CA_CERTS=/etc/pki/rds/global-bundle.pem; without this the app
# fails to reach RDS (force_ssl=1) with a P1010 cert error. World-readable so
# the unprivileged `node` user can read it.
RUN mkdir -p /etc/pki/rds \
  && wget -qO /etc/pki/rds/global-bundle.pem \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

# Drop to the unprivileged `node` user shipped in the base image.
USER node

# The standalone bundle is rooted at the monorepo root (outputFileTracingRoot),
# so it already contains apps/web/server.js plus the traced node_modules and
# @pharmax/* workspace packages. Static assets are copied in alongside it per
# Next's standalone contract.
COPY --chown=node:node --from=builder /app/apps/web/.next/standalone ./
COPY --chown=node:node --from=builder /app/apps/web/.next/static ./apps/web/.next/static

# Bind to all interfaces; PORT is overridden by the ECS task definition.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
