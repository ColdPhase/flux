ARG E2E_IMAGE=flux-e2e:local
FROM ${E2E_IMAGE}

# The Chromium proof uses a locked browser SDK without adding a production
# dependency to Flux. The UMD bundle is loaded from disk.
COPY infra/live-sfu-test/package*.json /opt/live-sfu/
RUN npm ci --prefix /opt/live-sfu --ignore-scripts --no-audit --no-fund
