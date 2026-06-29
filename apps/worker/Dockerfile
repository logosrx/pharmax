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

# ca-certificates + openssl for TLS to RDS / Secrets Manager / KMS.
# corepack pins pnpm from package.json `packageManager`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

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
