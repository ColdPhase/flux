FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /calibration
RUN corepack enable && corepack install -g pnpm@12.6.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch && pnpm install --offline --frozen-lockfile --ignore-scripts
COPY . ./
USER node
# The standalone image is never an application service or production build target.
CMD ["node", "inventory.mjs"]
