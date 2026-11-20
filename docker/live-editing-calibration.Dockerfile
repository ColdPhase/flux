FROM node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /calibration
RUN corepack enable && corepack install -g pnpm@12.6.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch && pnpm install --offline --frozen-lockfile --ignore-scripts
COPY . ./
USER node
# The standalone image is never an application service or production build target.
CMD ["node", "inventory.mjs"]
