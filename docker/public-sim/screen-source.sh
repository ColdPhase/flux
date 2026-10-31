#!/bin/sh
# The moving content of a simulated person's screen (#63): on PATTERN starts ffplay over the whole X display :99,
# off stops it. PATTERN is an ffmpeg lavfi source, for example testsrc2=size=1920x1080:rate=30, or gst:PROPERTIES
# for GStreamer's videotestsrc at 60 fps, for example gst:pattern=smpte horizontal-speed=6 (the whole frame moves). Browsers that share
# this screen keep their own windows off it (Chromium: --window-position=1920,0), or start before it, so the
# pattern stays on top without a window manager.
set -eu
export DISPLAY=:99
case "$1" in
  # gst:PROPERTIES draws GStreamer's videotestsrc with those properties at 1920x1080 and 60 fps (ximagesink keeps up
  # with 60 fps on Xvfb where ffplay managed about 30).
  on) pkill -x ffplay 2>/dev/null || true; pkill -f 'gst-launch-1.0' 2>/dev/null || true
      case "$2" in gst:*)
        # shellcheck disable=SC2086
        nohup gst-launch-1.0 -q videotestsrc is-live=true ${2#gst:} ! video/x-raw,width=1920,height=1080,framerate=60/1 ! ximagesink </dev/null >/tmp/gst.log 2>&1 &
        sleep 2; pgrep -f gst-launch-1.0 >/dev/null && echo "screen source on: $2"; exit 0 ;;
      esac
      nohup ffplay -loglevel error -an -noborder -left 0 -top 0 -x 1920 -y 1080 -f lavfi -i "$2" </dev/null >/tmp/ffplay.log 2>&1 &
      sleep 2; pgrep -x ffplay >/dev/null && echo "screen source on: $2" ;;
  off) pkill -x ffplay 2>/dev/null || true; pkill -f 'gst-launch-1.0' 2>/dev/null || true; echo "screen source off" ;;
  *) exit 2 ;;
esac
