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
  # size WxH: restart the X display at that size (between runs only: no browser may be open on it).
  size) pkill -x Xvfb 2>/dev/null || true; sleep 1
        nohup Xvfb :99 -screen 0 "${2}x24" -dpi 96 -extension RANDR -nolisten tcp </dev/null >/tmp/xvfb.log 2>&1 &
        printf '%s\n' "$2" > /tmp/screen-size
        for attempt in 1 2 3 4 5 6 7 8 9 10; do xdpyinfo >/dev/null 2>&1 && break; sleep 0.5; done
        echo "screen size $2" ;;
  # text static|scroll RATE: a terminal over the whole display with the known code text of textcorpus.py, Liberation
  # Mono 10.5 pt at 96 dpi (14 px), light text on a dark background; scroll prints RATE lines a second.
  text) pkill -x ffplay 2>/dev/null || true; pkill -f 'gst-launch-1.0' 2>/dev/null || true; pkill -x xterm 2>/dev/null || true
        shift
        nohup xterm -fa 'Liberation Mono' -fs 10.5 -geometry 300x100+0+0 -bg '#1e1e1e' -fg '#d4d4d4' -bw 0 -b 0 +sb \
          -e python3 /usr/local/bin/textcorpus.py "$@" </dev/null >/tmp/xterm.log 2>&1 &
        sleep 2; pgrep -x xterm >/dev/null && echo "text source on: $*" ;;
  # grab FILE: the display's current pixels, as the receiver should see them (PNG).
  grab) size=$(cat /tmp/screen-size 2>/dev/null || echo 1920x1080)
        ffmpeg -loglevel error -y -f x11grab -video_size "$size" -i :99 -frames:v 1 "$2" && echo "grabbed $2" ;;
  off) pkill -x xterm 2>/dev/null || true; pkill -x ffplay 2>/dev/null || true; pkill -f 'gst-launch-1.0' 2>/dev/null || true; echo "screen source off" ;;
  *) exit 2 ;;
esac
