FROM node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
WORKDIR /calibration
RUN corepack enable && corepack install -g pnpm@12.6.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch && pnpm install --offline --frozen-lockfile --ignore-scripts
COPY . ./
USER node
# The standalone image is never an application service or production build target.
CMD ["node", "inventory.mjs"]
