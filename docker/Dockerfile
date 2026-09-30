FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
RUN corepack enable && corepack install -g pnpm@12.6.0
# Cache the locked dependency download independently of source edits. No production-only
# filter: the build/type/lint/test stages need the full locked workspace toolchain.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
# The pinned OAuth provider patch is part of the locked dependency graph (#152).
COPY patches ./patches
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build && pnpm typecheck && pnpm lint

FROM build AS test
CMD ["pnpm", "test"]

FROM build AS production-dependencies
RUN pnpm install --prod --offline --frozen-lockfile

# Browser checks only (issue #41): the built workspace on the official Playwright image,
# whose bundled Chromium matches the pinned playwright 1.63.0 package. Never deployed.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS e2e
WORKDIR /app
COPY --from=build /app /app
CMD ["node_modules/.bin/tsx", "--test", "tests/app/e2e/pwa.e2e.ts"]

FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=production-dependencies /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=production-dependencies /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=production-dependencies /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=production-dependencies /app/packages/agent-runtime/node_modules ./packages/agent-runtime/node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/agent-runtime/package.json ./packages/agent-runtime/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/agent-runtime/dist ./packages/agent-runtime/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/tooling/dist ./tooling/dist
RUN mkdir -p /data/files && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
