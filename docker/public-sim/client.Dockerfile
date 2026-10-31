# A simulated person's computer behind a NAT router (#63): pinned Playwright browsers and a
# Playwright server the test driver reaches through the router's single forwarded port, plus the tools of the
# synthetic media profiles (ffmpeg, espeak-ng, PulseAudio), tcpdump for transport observations and xdotool for a
# person's answer to WebKit's screen-sharing prompt (allow-display.sh).
FROM mcr.microsoft.com/playwright/python:v1.62.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 libnss3-tools ca-certificates curl \
    ffmpeg espeak-ng pulseaudio pulseaudio-utils procps xdotool \
    gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-x \
  && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
RUN pip install --break-system-packages --no-cache-dir --require-hashes -r /tmp/requirements.txt
