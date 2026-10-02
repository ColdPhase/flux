ARG E2E_IMAGE=flux-e2e:local
FROM ${E2E_IMAGE}

# The isolated relay proof denies UDP and direct ICE/TCP from the client
# container. This package is never included in a runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends iptables iproute2 libnss3-tools && rm -rf /var/lib/apt/lists/*

# The Chromium proof uses a locked browser SDK without adding a production
# dependency to Flux. The UMD bundle is loaded from disk.
COPY tooling/live-sfu-test/package*.json /opt/live-sfu/
RUN npm ci --prefix /opt/live-sfu --ignore-scripts --no-audit --no-fund
