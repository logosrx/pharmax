# =====================================================================
# Pharmax web (Next.js) image.
#
# STATUS: stub. Activated in Phase 0 task #3 once apps/web exists.
# Do not add this to docker-compose.yml or CI build matrices yet.
# =====================================================================

ARG NODE_VERSION=22-alpine

# ---- deps -----------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --filter=pharmacy-os...

# ---- build ----------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /repo
RUN corepack enable
COPY --from=deps /repo /repo
COPY apps/web ./apps/web
RUN pnpm --filter pharmacy-os build

# ---- runtime --------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN corepack enable && addgroup -S pharmax && adduser -S pharmax -G pharmax
COPY --from=build /repo/apps/web/.next ./.next
COPY --from=build /repo/apps/web/public ./public
COPY --from=build /repo/apps/web/package.json ./package.json
COPY --from=build /repo/node_modules ./node_modules
USER pharmax
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
