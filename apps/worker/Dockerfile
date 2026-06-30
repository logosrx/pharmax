# syntax=docker/dockerfile:1
#
# Worker image (apps/worker). pnpm monorepo + Prisma 7 `prisma-client`
# generator (Rust-free, ESM, pg driver adapter) + tsx runtime.
#
# Build context is the REPO ROOT (see .dockerignore). Build for
# linux/amd64 to match the Fargate task's X86_64 runtime platform:
#
#   docker buildx build --platform linux/amd64 \
#     -f apps/worker/Dockerfile \
#     -t <registry>/pharmax-prod-ue1/worker:<tag> --push .
#
# The CI path (.github/workflows/deploy.yml) builds this on an amd64
# runner natively.

FROM node:22-bookworm-slim

# ca-certificates + openssl for TLS to RDS / Secrets Manager / KMS; wget to
# fetch the RDS CA bundle below.
# corepack pins pnpm from package.json `packageManager`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl wget \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Amazon RDS global CA bundle. Prisma 7's `pg` driver does verify-full TLS
# (sslmode=require is treated as verify-full by pg-connection-string >= 2.x),
# so node must trust the RDS chain. The ECS task sets
# NODE_EXTRA_CA_CERTS=/etc/pki/rds/global-bundle.pem; without this the worker
# fails to reach RDS (force_ssl=1) with a P1010 cert error. World-readable so
# the unprivileged `node` user can read it.
RUN mkdir -p /etc/pki/rds \
    && wget -qO /etc/pki/rds/global-bundle.pem \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

ENV NODE_ENV=production \
    CI=true

WORKDIR /app
RUN chown node:node /app
USER node

# Copy the whole workspace (node_modules / build output excluded by
# .dockerignore) owned by the runtime user, then install once. Running
# `pnpm install` as `node` during build bakes the corepack pnpm@11.1.1
# download into the image, so container start does not hit the network
# for the package manager.
COPY --chown=node:node . .

# Frozen install of the full workspace, then generate the Prisma client
# into packages/database/src/generated/client. `db:generate` also runs
# in postinstall; calling it explicitly guards against a stale client.
RUN pnpm install --frozen-lockfile \
    && pnpm db:generate

WORKDIR /app/apps/worker

# main.ts starts the poll loops, writes the /tmp/pharmax-worker-alive
# liveness marker the ECS health check probes, and waits on SIGTERM for
# graceful shutdown. `pnpm start` -> `tsx src/main.ts`.
CMD ["pnpm", "start"]
