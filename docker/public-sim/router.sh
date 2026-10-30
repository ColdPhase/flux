#!/bin/sh
# NAT router of one simulated client network (#63). Usage: router.sh CLIENT_IP PROFILE
#   restrictive: only TCP/443 and DNS to the simulation's resolver leave the network (a strict office or hotel);
#   open: everything leaves (a home router).
# The driver reaches the client's Playwright server through the one forwarded port, TCP/3000.
set -eu
client=$1 profile=$2
inet=$(ip -o -4 addr show | awk '$4 ~ /^203\.0\.113\./ { print $2; exit }')
lan=$(ip -o -4 addr show | awk '$4 ~ /^10\.213\./ { print $2; exit }')
test -n "$inet" && test -n "$lan"
echo "$inet" > /run/inet-if; echo "$lan" > /run/lan-if
iptables -t nat -A POSTROUTING -o "$inet" -j MASQUERADE
iptables -t nat -A PREROUTING -i "$inet" -p tcp --dport 3000 -j DNAT --to-destination "$client:3000"
iptables -P FORWARD DROP
iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FORWARD -i "$inet" -o "$lan" -p tcp -d "$client" --dport 3000 -j ACCEPT
iptables -A FORWARD -i "$lan" -o "$inet" -p udp -d 203.0.113.53 --dport 53 -j ACCEPT
case "$profile" in
  # Two rules so the counters tell TURN/TLS (the media host) from HTTPS (the proxy).
  restrictive) iptables -A FORWARD -i "$lan" -o "$inet" -p tcp -d 203.0.113.20 --dport 443 -j ACCEPT
    iptables -A FORWARD -i "$lan" -o "$inet" -p tcp --dport 443 -j ACCEPT ;;
  open) iptables -A FORWARD -i "$lan" -o "$inet" -j ACCEPT ;;
  *) echo "unknown profile $profile" >&2; exit 2 ;;
esac
iptables -A FORWARD -i "$lan" -j REJECT
echo "router ready: $profile, client $client, internet $inet, lan $lan"
exec sleep infinity
