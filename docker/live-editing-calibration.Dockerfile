FROM node@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725
WORKDIR /calibration
RUN corepack enable && corepack install -g pnpm@12.6.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch && pnpm install --offline --frozen-lockfile --ignore-scripts
COPY . ./
USER node
# The standalone image is never an application service or production build target.
CMD ["node", "inventory.mjs"]
