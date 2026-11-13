# Harness probe image (2026-11-13). Throwaway: built and run only for docs/product/research/agent-harness-2026-11.md.
FROM node:22.21.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 time procps git ripgrep python3 \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.5.2 \
 && npm install -g @charmland/crush@0.101.0 @qwen-code/qwen-code@0.27.3 @anthropic-ai/claude-code@2.1.323 @openai/codex@0.169.0 \
 && npm cache clean --force
RUN mkdir -p /opt/opencode /opt/goose \
 && curl -fsSL https://github.com/anomalyco/opencode/releases/download/v2.3.0/opencode-linux-x64.tar.gz | tar -xz -C /opt/opencode \
 && curl -fsSL https://github.com/aaif-goose/goose/releases/download/v1.59.0/goose-x86_64-unknown-linux-gnu.tar.bz2 | tar -xj -C /opt/goose \
 && ls -la /opt/opencode /opt/goose
ENV PATH=/opt/opencode:/opt/goose:$PATH
RUN useradd -m -u 20001 agent
USER agent
WORKDIR /home/agent
