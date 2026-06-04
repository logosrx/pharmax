# syntax=docker/dockerfile:1.7
# =============================================================================
# Print-agent (apps/print-agent) — production container image.
#
# IMPORTANT: build context MUST be the repo root (pnpm workspace):
#
#   docker build -f apps/print-agent/Dockerfile -t pharmax/print-agent .
#
# Like the worker, the print-agent runs its TypeScript entrypoint directly
# via tsx (see apps/print-agent/package.json `start`), so the runtime image
# carries the workspace source + the generated Prisma client rather than a
# compiled JS bundle. The ECS health check tests for
# /tmp/pharmax-print-agent-alive, which the process writes on boot
# (apps/print-agent/src/runtime/liveness.ts).
#
# NOTE: in deployments where the print-agent runs ZPL-over-TCP to a
# physical Zebra printer on a pharmacy LAN, it is typically run on-prem
# (workstation/edge) rather than in Fargate. This image supports the
# Fargate-managed mode that Terraform provisions (e.g. ZPL-over-HTTP or a
# file/queue transport); pick the transport via PRINT_AGENT_ZPL_MODE.
# =============================================================================

# ---- Base: pinned Node + pnpm via corepack ---------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
# OpenSSL is a runtime dependency of Prisma's query engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ---- Deps: install workspace deps + generate Prisma client -----------------
FROM base AS deps
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

# ---- Runner ----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
USER node
# Bring the fully-installed monorepo (node_modules incl. tsx, the
# @pharmax/* workspace packages, and the generated Prisma client) from
# the deps stage.
COPY --chown=node:node --from=deps /app ./

CMD ["pnpm", "--filter", "pharmacy-print-agent", "start"]
