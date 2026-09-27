FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
RUN corepack enable && corepack install -g pnpm@12.6.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build && pnpm typecheck && pnpm lint

FROM build AS test
CMD ["pnpm", "test"]

FROM build AS production-dependencies
RUN pnpm install --prod --offline --frozen-lockfile

FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=production-dependencies /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=production-dependencies /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=production-dependencies /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/infra/dist ./infra/dist
RUN mkdir -p /data/files && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
