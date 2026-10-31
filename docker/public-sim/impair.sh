#!/bin/sh
# Impairments on a simulated router (#63). drop on|off: cut every path through the router except the driver's
# TCP/3000; netem ARGS|off: apply tc netem both ways (toward the client and toward the Internet).
set -eu
inet=$(cat /run/inet-if) lan=$(cat /run/lan-if)
case "$1" in
  drop)
    if [ "$2" = on ]; then
      iptables -N SIMDROP
      iptables -A SIMDROP -p tcp --sport 3000 -j RETURN
      iptables -A SIMDROP -p tcp --dport 3000 -j RETURN
      iptables -A SIMDROP -j DROP
      iptables -I FORWARD 1 -j SIMDROP
    else
      iptables -L SIMDROP -n -v | sed -n '1,6p'
      iptables -D FORWARD -j SIMDROP; iptables -F SIMDROP; iptables -X SIMDROP
    fi ;;
  netem)
    shift
    if [ "$1" = off ]; then
      tc -s qdisc show dev "$lan" | head -4
      tc qdisc del dev "$lan" root; tc qdisc del dev "$inet" root
    else
      tc qdisc replace dev "$lan" root netem "$@"; tc qdisc replace dev "$inet" root netem "$@"
    fi ;;
  turn-udp)
    # Also let TURN over UDP (3478, the media host only) leave: direct ICE stays blocked, so media must relay,
    # without TLS. Used where a browser cannot be made to trust the simulation's CA for TURN/TLS.
    if [ "$2" = on ]; then iptables -I FORWARD 2 -i "$lan" -o "$inet" -p udp -d 203.0.113.20 --dport 3478 -j ACCEPT
    else iptables -D FORWARD -i "$lan" -o "$inet" -p udp -d 203.0.113.20 --dport 3478 -j ACCEPT; fi ;;
  counters) iptables -L FORWARD -n -v ;;
  *) exit 2 ;;
esac
