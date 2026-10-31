#!/bin/sh
# The moving content of a simulated person's screen (#63): on PATTERN starts ffplay over the whole X display :99,
# off stops it. PATTERN is an ffmpeg lavfi source, for example testsrc2=size=1920x1080:rate=60. Browsers that share
# this screen keep their own windows off it (Chromium: --window-position=1920,0), or start before it, so the
# pattern stays on top without a window manager.
set -eu
export DISPLAY=:99
case "$1" in
  on) pkill -x ffplay 2>/dev/null || true
      nohup ffplay -loglevel error -an -noborder -left 0 -top 0 -x 1920 -y 1080 -f lavfi -i "$2" </dev/null >/tmp/ffplay.log 2>&1 &
      sleep 2; pgrep -x ffplay >/dev/null && echo "screen source on: $2" ;;
  off) pkill -x ffplay 2>/dev/null || true; echo "screen source off" ;;
  *) exit 2 ;;
esac
