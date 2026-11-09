# Set by BuildKit for the platform being built; selects the pinned Codex download (agent runtime).
ARG TARGETARCH
# The one tag of the pinned Codex (#1133): its binaries, its code-mode host and its model catalog are all fetched by it, each checked against
# its own sha256, so a bump of this tag cannot keep an old catalog: the catalog's digest then fails until it is updated with the others.
ARG CODEX_TAG=rust-v0.160.1
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime-hardening-build
RUN apk add --no-cache gcc musl-dev
COPY apps/runtime/native/protect.c /native/protect.c
RUN cc -std=c11 -Wall -Wextra -Werror -fPIC -shared -I/usr/local/include/node /native/protect.c -o /native/protect.node

# The toolchain shared by the build and the production dependencies: pnpm, the compiler node-pty needs, and the
# lockfile with its patches. Each stage below downloads its own locked dependencies in a layer that source edits
# do not invalidate.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS toolchain
WORKDIR /app
RUN corepack enable && corepack install -g pnpm@12.6.0
# node-pty (the agent runtime's sign-in console, F-022 T4 #279) has no Linux prebuild, so it compiles
# here against this Node's own headers. Only these stages have the compiler; later images copy the addon.
RUN apk add --no-cache python3 make g++ linux-headers
ENV npm_config_nodedir=/usr/local
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
# The pinned OAuth provider patch is part of the locked dependency graph (#152).
COPY patches ./patches

FROM toolchain AS build
# No production-only filter: the build/type/lint/test stages need the full locked workspace toolchain.
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

# The application image's dependencies: installed from the lockfile into an empty tree, production only, and without the
# browser app (@flux/web) and the SDK, which the server never loads (the browser code is already bundled in apps/web/dist).
# Not derived from `build`: its virtual store would keep every build, lint and test package (about 195 MB, #862).
FROM toolchain AS production-store
# Only the production packages of the lockfile. `pnpm fetch` also lays out a virtual store under /app/node_modules
# for everything it fetched, so only the content-addressed store and the metadata cache are taken from this stage.
RUN pnpm fetch --prod

FROM toolchain AS production-dependencies
COPY --from=production-store /root/.local/share/pnpm /root/.local/share/pnpm
COPY --from=production-store /root/.cache/pnpm /root/.cache/pnpm
COPY . .
RUN pnpm install --prod --offline --frozen-lockfile --filter '!@flux/web' --filter '!@flux/sdk' --filter '!@flux/example-external-agent'
# The slot image needs node-pty's JavaScript, its licence and the addon built above, not its 60 MB of
# Windows and macOS prebuilds and sources: the link becomes a directory with exactly those files, and
# the store copy is dropped, so the application image does not carry it either.
RUN set -eu; d=apps/runtime/node_modules/node-pty; t=$(readlink -f "$d"); rm "$d"; mkdir -p "$d/build/Release"; \
  cp "$t/package.json" "$t/LICENSE" "$d/"; cp -R "$t/lib" "$d/"; cp "$t/build/Release/pty.node" "$d/build/Release/"; \
  find "$d/lib" \( -name '*.test.js' -o -name '*.map' \) -delete; rm -rf "$t"; \
  node -e "require('/app/$d')"
# Nothing the server loads: better-auth's optional peers (drizzle-kit and its esbuild for its CLI, React's DOM renderer for
# its email templates; Flux uses neither), type declarations, source maps and Markdown. Licence files stay.
RUN set -eu; cd node_modules; \
  rm -rf .pnpm/drizzle-kit@* .pnpm/esbuild@* .pnpm/@esbuild+* .pnpm/@esbuild-kit+* .pnpm/esbuild-register@* .pnpm/react-dom@* .pnpm/react@* .pnpm/@types+*; \
  find /app/node_modules /app/apps/*/node_modules /app/packages/*/node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
    -o \( -iname '*.md' ! -iname '*LICEN[CS]E*' ! -iname 'NOTICE*' \) \) -delete

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
RUN mkdir -p /data /opt/flux-tools /opt/flux-runtime/codex/bin && chown node:node /opt/flux-tools && chmod 0711 /data
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
ARG CODEX_TAG
ADD --checksum=sha256:9226581be592d18f7e7f740a352fdb63aa61e45e39f7eb9b09d3888c84bba33f https://github.com/openai/codex/releases/download/${CODEX_TAG}/codex-x86_64-unknown-linux-musl.tar.gz /codex.tar.gz
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS codex-arm64
ARG CODEX_TAG
ADD --checksum=sha256:f54dc5852042445bf41da3aa31156f3cb02f52c5a1a04074de73dc5598f7e1f7 https://github.com/openai/codex/releases/download/${CODEX_TAG}/codex-aarch64-unknown-linux-musl.tar.gz /codex.tar.gz
FROM codex-${TARGETARCH} AS codex
RUN mkdir /tmp/codex && tar -xzf /codex.tar.gz -C /tmp/codex && set -- /tmp/codex/* && [ "$#" -eq 1 ] && install -m 0755 "$1" /codex

# TEST ONLY, opt-in (#152 AC-4, scripts/check_mcp_clients.sh): the browser-check image with the pinned REAL
# Codex (from the `codex` stage above) so both vendors' CLIs can register and use Flux's MCP server. Claude
# Code is never in an image: the check downloads the pinned, signature-checked release at run time with the
# same installer the runtime uses (gpg is only here for that; musl because the release is the musl build). No vendor account or sign-in is involved.
# Codex 0.160.1 runs MCP tool calls through a separate code-mode host binary (a release asset of the same tag).
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS codex-host-amd64
ARG CODEX_TAG
ADD --checksum=sha256:8a69207d97545ac753b6585974e1e67a4c51ae5deacf06517db512bb25e0e3c2 https://github.com/openai/codex/releases/download/${CODEX_TAG}/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz /host.tar.gz
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS codex-host-arm64
ARG CODEX_TAG
ADD --checksum=sha256:e5e027e6689efda2e3570aa600179f0ebb18632803350e152ed6c9b97dcf9741 https://github.com/openai/codex/releases/download/${CODEX_TAG}/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz /host.tar.gz
FROM codex-host-${TARGETARCH} AS codex-host
RUN mkdir /tmp/host && tar -xzf /host.tar.gz -C /tmp/host && set -- /tmp/host/* && [ "$#" -eq 1 ] && install -m 0755 "$1" /codex-code-mode-host

FROM e2e AS mcp-clients
RUN apt-get update && apt-get install -y --no-install-recommends gnupg musl && rm -rf /var/lib/apt/lists/*
COPY --from=codex /codex /usr/local/bin/codex
COPY --from=codex-host /codex-code-mode-host /usr/local/bin/codex-code-mode-host
ENV PATH="/opt/flux-tools/claude/bin:$PATH"

# The pinned Codex's own model catalog (codex-rs/models-manager/models.json at rust-v0.160.1, the file built into that binary; sha256
# checked 2026-11-09), rewritten with the tool settings Flux reviewed (apps/runtime/src/supervisor/templates.ts CODEX_MODEL_REVIEW, #1127):
# every Codex run passes it as `model_catalog_json`, so Flux's MCP tools reach the model as plain tools, without code mode or sub-agents.
FROM build AS codex-catalog
ARG CODEX_TAG
ADD --checksum=sha256:fd219bd9f061278275f528939f82f54d2eb97df4b25c23b022adbe48813d920b https://raw.githubusercontent.com/openai/codex/${CODEX_TAG}/codex-rs/models-manager/models.json /codex-vendor-models.json
RUN node apps/runtime/dist/install/codex-catalog.js /codex-vendor-models.json /codex-models.json

FROM agent-runtime-base AS agent-runtime
COPY --from=codex /codex /opt/flux-runtime/codex/bin/codex
COPY --from=codex-catalog /codex-models.json /opt/flux-runtime/codex/models.json

# TEST ONLY (#1125, scripts/check_cli_runtime.sh): the runtime image above with its REAL pinned Codex behind a wrapper that points
# its vendor hosts at the local mock, plus the Claude Code wrapper and the install step that puts it in the tools volume
# (app/tests/cli-runtime). The supervisor, its templates and the binaries are the ones above. Never deployed.
FROM agent-runtime AS agent-runtime-cli-mock
USER root
COPY tests/cli-runtime/ /opt/flux-cli-mock/
RUN mv /opt/flux-runtime/codex/bin/codex /opt/flux-cli-mock/codex \
  && install -m 0755 /opt/flux-cli-mock/codex.sh /opt/flux-runtime/codex/bin/codex \
  && chmod 0755 /opt/flux-cli-mock/claude.sh /opt/flux-cli-mock/install.sh
USER node

# The one-shot installer needs gpg to check Anthropic's signed release manifest; slots do not.
FROM agent-runtime AS agent-runtime-install
USER root
RUN apk add --no-cache gnupg
USER node
CMD ["node", "apps/runtime/dist/install/main.js"]

# The published agent-runtime image (#358, ghcr.io/coldphase/flux-agent-runtime): the slot supervisor with
# the pinned official Codex, and gpg so the SAME digest also runs the one-shot `runtime-install`
# (docker/compose.runtime.yaml gives that service its own command). Claude Code is never in it. The source
# Compose keeps building the separate, gpg-free `agent-runtime` slot image above.
FROM agent-runtime AS agent-runtime-release
USER root
RUN apk add --no-cache gnupg
USER node
CMD ["node", "--disable-sigusr1", "apps/runtime/dist/supervisor/main.js"]

# The Node the application image runs on: the pinned image without what only a build uses. npm, corepack and yarn
# (24 MB, and their bundled dependencies, which an image scan reports for code that never runs) and Node's C headers
# go. A RUN rm over the base would leave the files in its layer; `scratch` and one COPY make the removal real.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS node-slim-files
RUN rm -rf /usr/local/lib/node_modules /usr/local/include/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*
FROM scratch AS node-slim
COPY --from=node-slim-files / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node"]

# The application image. It stays the LAST stage: builds without --target (Compose's migrate, the
# release workflow) produce it.
FROM node-slim AS runtime
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
# The keyring of encrypted workspaces (F-030): Node built-ins only, its own command on this image.
COPY --from=build /app/apps/keyring/package.json ./apps/keyring/package.json
COPY --from=build /app/apps/keyring/dist ./apps/keyring/dist
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
