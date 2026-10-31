#!/bin/sh
# A simulated client computer (#63): its only route is the NAT router, its only resolver the
# simulation's DNS, and it trusts the simulation's CA like an installed root.
set -eu
router=$1
ip route replace default via "$router"
printf 'nameserver 203.0.113.53\n' > /etc/resolv.conf
cp /certs/ca.crt /usr/local/share/ca-certificates/flux-sim-ca.crt
update-ca-certificates >/dev/null 2>&1
mkdir -p /root/.pki/nssdb
[ -f /root/.pki/nssdb/cert9.db ] || certutil -N -d sql:/root/.pki/nssdb --empty-password
certutil -A -d sql:/root/.pki/nssdb -n flux-sim-ca -t 'C,,' -i /certs/ca.crt
export NODE_EXTRA_CA_CERTS=/certs/ca.crt
exec python3 -m playwright run-server --port 3000 --host 0.0.0.0 --unsafe
