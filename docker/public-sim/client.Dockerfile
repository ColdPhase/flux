# A simulated person's computer behind a NAT router (#63): pinned Playwright browsers and a
# Playwright server the test driver reaches through the router's single forwarded port.
FROM mcr.microsoft.com/playwright/python:v1.62.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 libnss3-tools ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
RUN pip install --break-system-packages --no-cache-dir --require-hashes -r /tmp/requirements.txt
