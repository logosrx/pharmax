# =====================================================================
# Pharmax worker (BullMQ consumer) image.
#
# STATUS: stub. Activated in Phase 0 task #4 once apps/worker exists.
# Do not add this to docker-compose.yml or CI build matrices yet.
# =====================================================================

ARG NODE_VERSION=22-alpine

# ---- deps -----------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/worker/package.json ./apps/worker/package.json
RUN pnpm install --frozen-lockfile --filter=@pharmax/worker...

# ---- runtime --------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && addgroup -S pharmax && adduser -S pharmax -G pharmax
COPY --from=deps /repo /app
COPY apps/worker ./apps/worker
USER pharmax
CMD ["pnpm", "--filter", "@pharmax/worker", "start"]
