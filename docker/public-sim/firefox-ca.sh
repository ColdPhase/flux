#!/bin/sh
# Playwright's Firefox with the simulation's CA in its profile's certificate database (#63), as a person imports
# a root certificate in Settings > Privacy & Security > Certificates. Firefox's built-in roots are compiled in and
# its policies file is not read by Playwright's build, so the profile database is the trust store to change.
# Playwright passes the fresh profile directory as `-profile DIR`; the driver names this file as executablePath.
set -eu
profile=
previous=
for arg in "$@"; do
  [ "$previous" = -profile ] && profile=$arg
  previous=$arg
done
if [ -n "$profile" ]; then
  [ -f "$profile/cert9.db" ] || certutil -N -d "sql:$profile" --empty-password
  certutil -A -d "sql:$profile" -n flux-sim-ca -t 'C,,' -i /certs/ca.crt
fi
exec "$(ls -d /ms-playwright/firefox-*/firefox | head -1)/firefox" "$@"
