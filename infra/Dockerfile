FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build && pnpm typecheck && pnpm lint

FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
RUN corepack enable
COPY --from=build /app /app
EXPOSE 8080
CMD ["pnpm", "exec", "tsx", "apps/server/src/index.ts"]
