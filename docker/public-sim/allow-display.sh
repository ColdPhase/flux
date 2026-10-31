#!/bin/sh
# The person's answer to WebKit's own screen-sharing prompt on a simulated computer (#63). Playwright's Linux WebKit
# (MiniBrowser, headed on the X display :99) asks "UserMedia request: Allow access to display device?" in an info
# bar with No and Yes at the right end of its top row; this presses Yes, as a person would. Usage: allow-display.
set -u
export DISPLAY=:99
best= area=0
for id in $(xdotool search --onlyvisible --name '.' 2>/dev/null); do
  geometry=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null) || continue
  eval "$geometry"
  if [ $((WIDTH * HEIGHT)) -gt "$area" ]; then area=$((WIDTH * HEIGHT)); best="$X $Y $WIDTH"; fi
done
[ -n "$best" ] || { echo 'no browser window'; exit 1; }
set -- $best
xdotool mousemove $(($1 + $3 - 36)) $(($2 + 68)) click 1
echo "pressed Yes at $(($1 + $3 - 36)),$(($2 + 68))"
