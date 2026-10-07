# Set by BuildKit for the platform being built; selects the pinned Codex download (agent runtime).
ARG TARGETARCH
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime-hardening-build
RUN apk add --no-cache gcc musl-dev
COPY apps/runtime/native/protect.c /native/protect.c
RUN cc -std=c11 -Wall -Wextra -Werror -fPIC -shared -I/usr/local/include/node /native/protect.c -o /native/protect.node

FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
RUN corepack enable && corepack install -g pnpm@12.6.0
# node-pty (the agent runtime's sign-in console, F-022 T4 #279) has no Linux prebuild, so it compiles
# here against this Node's own headers. Only this stage has the compiler; later images copy the addon.
RUN apk add --no-cache python3 make g++ linux-headers
ENV npm_config_nodedir=/usr/local
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
# Fixtures share the private files volume with the runtime API. Use its identity so
# a fixture's 0700 object shard remains writable by the API, independent of UUID order.
USER node
# Dependencies are already baked in. Running the installed binary also avoids a
# user-specific package-manager bootstrap mutating the root-owned build workspace.
CMD ["sh", "-c", "exec node_modules/.bin/tsx --test --test-concurrency=1 tests/app/*.test.ts"]

FROM build AS production-dependencies
RUN pnpm install --prod --offline --frozen-lockfile
# The slot image needs node-pty's JavaScript, its licence and the addon built above, not its 60 MB of
# Windows and macOS prebuilds and sources: the link becomes a directory with exactly those files, and
# the store copy is dropped, so the application image does not carry it either.
RUN set -eu; d=apps/runtime/node_modules/node-pty; t=$(readlink -f "$d"); rm "$d"; mkdir -p "$d/build/Release"; \
  cp "$t/package.json" "$t/LICENSE" "$d/"; cp -R "$t/lib" "$d/"; cp "$t/build/Release/pty.node" "$d/build/Release/"; \
  find "$d/lib" \( -name '*.test.js' -o -name '*.map' \) -delete; rm -rf "$t"; \
  node -e "require('/app/$d')"

# Browser checks only (issue #41): the built workspace on the official Playwright image,
# whose bundled Chromium matches the pinned playwright 1.63.0 package. Never deployed.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS e2e
WORKDIR /app
COPY --from=build /app /app
CMD ["node_modules/.bin/tsx", "--test", "tests/app/e2e/pwa.e2e.ts"]

# --- The agent runtime slot image (F-022 AIM-3, T3 #278): the supervisor (Node built-ins, and node-pty
# for the sign-in console's terminal, T4 #279) on the same pinned Node base, and nothing of the application. Claude Code is never in an image: the
# `runtime-install` service puts the pinned, signature-checked release into the tools volume.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS agent-runtime-base
WORKDIR /opt/flux-runtime
ENV NODE_ENV=production
COPY --from=build /app/packages/runtime-protocol/package.json ./packages/runtime-protocol/package.json
COPY --from=build /app/packages/runtime-protocol/dist ./packages/runtime-protocol/dist
COPY --from=build /app/apps/runtime/package.json ./apps/runtime/package.json
COPY --from=build /app/apps/runtime/dist ./apps/runtime/dist
COPY --from=runtime-hardening-build /native/protect.node ./apps/runtime/native/protect.node
COPY --from=build /app/apps/runtime/keys ./apps/runtime/keys
COPY --from=production-dependencies /app/apps/runtime/node_modules ./apps/runtime/node_modules
RUN mkdir -p /data /opt/flux-tools /opt/flux-runtime/codex/bin && chown node:node /data /opt/flux-tools && chmod 0700 /data
USER node
CMD ["node", "--disable-sigusr1", "apps/runtime/dist/supervisor/main.js"]

# TEST ONLY: fake `claude` and `codex` (apps/runtime/src/fakes) instead of the vendors' CLIs. The fake
# Claude Code reaches the tools volume through runtime-install, like the real one. Never deployed.
FROM agent-runtime-base AS agent-runtime-test
USER root
RUN mkdir -p /opt/flux-fakes \
  && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/flux-runtime/apps/runtime/dist/fakes/fake-claude.js "$@"\n' > /opt/flux-fakes/claude \
  && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/flux-runtime/apps/runtime/dist/fakes/fake-codex.js "$@"\n' > /opt/flux-runtime/codex/bin/codex \
  && chmod 0755 /opt/flux-fakes/claude /opt/flux-runtime/codex/bin/codex
USER node

# The pinned official Codex CLI (Apache-2.0), checked against the SHA-256 digests GitHub lists for the
# rust-v0.160.1 release assets (retrieved 2026-10-05). Codex stays off until T6 records its hosts.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS codex-amd64
ADD --checksum=sha256:9226581be592d18f7e7f740a352fdb63aa61e45e39f7eb9b09d3888c84bba33f https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-x86_64-unknown-linux-musl.tar.gz /codex.tar.gz
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS codex-arm64
ADD --checksum=sha256:f54dc5852042445bf41da3aa31156f3cb02f52c5a1a04074de73dc5598f7e1f7 https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-aarch64-unknown-linux-musl.tar.gz /codex.tar.gz
FROM codex-${TARGETARCH} AS codex
RUN mkdir /tmp/codex && tar -xzf /codex.tar.gz -C /tmp/codex && set -- /tmp/codex/* && [ "$#" -eq 1 ] && install -m 0755 "$1" /codex

FROM agent-runtime-base AS agent-runtime
COPY --from=codex /codex /opt/flux-runtime/codex/bin/codex

# The one-shot installer needs gpg to check Anthropic's signed release manifest; slots do not.
FROM agent-runtime AS agent-runtime-install
USER root
RUN apk add --no-cache gnupg
USER node
CMD ["node", "apps/runtime/dist/install/main.js"]

# The application image. It stays the LAST stage: builds without --target (Compose's migrate, the
# release workflow) produce it.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=production-dependencies /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=production-dependencies /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=production-dependencies /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=production-dependencies /app/packages/agent-runtime/node_modules ./packages/agent-runtime/node_modules
COPY --from=production-dependencies /app/apps/runtime/node_modules ./apps/runtime/node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/agent-runtime/package.json ./packages/agent-runtime/package.json
COPY --from=build /app/packages/runtime-protocol/package.json ./packages/runtime-protocol/package.json
COPY --from=build /app/apps/runtime/package.json ./apps/runtime/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/agent-runtime/dist ./packages/agent-runtime/dist
# runtime-manager and runtime-egress (F-022 AIM-3) run on this image; the slots use agent-runtime below.
COPY --from=build /app/packages/runtime-protocol/dist ./packages/runtime-protocol/dist
COPY --from=build /app/apps/runtime/dist ./apps/runtime/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/tooling/dist ./tooling/dist
RUN mkdir -p /data/files && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
