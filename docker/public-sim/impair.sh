#!/bin/sh
# Impairments on a simulated router (#63). drop on|off: cut every path through the router except the driver's
# TCP/3000; netem ARGS|off: apply tc netem both ways (toward the client and toward the Internet); netem-host IP
# ARGS|off: the same for one client of the network only (one weak receiver among several people), leaving the
# driver's TCP/3000 to that client unimpaired.
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
  netem-host)
    host=$2; shift 2
    if [ "$1" = off ]; then
      tc -s qdisc show dev "$lan" | grep -A2 netem | head -3
      tc qdisc del dev "$lan" root; tc qdisc del dev "$inet" root
      iptables -t mangle -F SIMHOST; iptables -t mangle -D FORWARD -j SIMHOST; iptables -t mangle -X SIMHOST
    else
      # Toward the client: match its address. Toward the Internet the source is already masqueraded when the
      # qdisc sees it, so the packet carries a mark set in FORWARD instead.
      iptables -t mangle -N SIMHOST
      iptables -t mangle -A SIMHOST -s "$host" -p tcp --sport 3000 -j RETURN
      iptables -t mangle -A SIMHOST -s "$host" -j MARK --set-mark 7
      iptables -t mangle -A FORWARD -j SIMHOST
      for dev in "$lan" "$inet"; do
        tc qdisc replace dev "$dev" root handle 1: prio bands 3 priomap 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1
        tc qdisc replace dev "$dev" parent 1:3 handle 30: netem "$@"
      done
      tc filter add dev "$lan" parent 1: protocol ip prio 1 u32 match ip dst "$host"/32 match ip dport 3000 0xffff flowid 1:2
      tc filter add dev "$lan" parent 1: protocol ip prio 2 u32 match ip dst "$host"/32 flowid 1:3
      tc filter add dev "$inet" parent 1: protocol ip prio 1 handle 7 fw flowid 1:3
    fi ;;
  turn-udp)
    # Also let TURN over UDP (3478, the media host only) leave: direct ICE stays blocked, so media must relay,
    # without TLS. Used where a browser cannot be made to trust the simulation's CA for TURN/TLS.
    if [ "$2" = on ]; then iptables -I FORWARD 2 -i "$lan" -o "$inet" -p udp -d 203.0.113.20 --dport 3478 -j ACCEPT
    else iptables -D FORWARD -i "$lan" -o "$inet" -p udp -d 203.0.113.20 --dport 3478 -j ACCEPT; fi ;;
  ice-tcp)
    # Also let ICE over TCP (7881, the media host only) leave: UDP stays blocked and no TLS is involved, so media
    # must take the SFU's direct TCP path. Used for WebKit, whose TURN/TLS cannot trust the simulation's CA.
    if [ "$2" = on ]; then iptables -I FORWARD 2 -i "$lan" -o "$inet" -p tcp -d 203.0.113.20 --dport 7881 -j ACCEPT
    else iptables -D FORWARD -i "$lan" -o "$inet" -p tcp -d 203.0.113.20 --dport 7881 -j ACCEPT; fi ;;
  counters) iptables -L FORWARD -n -v ;;
  sniff)
    # The first data a client of this network sends to TURN/TLS (the media host's TCP/443): a TLS ClientHello
    # starts with byte 0x16, a plain TURN Allocate with 0x00 0x03.
    # Then the server's answer and what follows, both ways, as packet summaries.
    timeout 25 tcpdump -n -l -i "$inet" -c 12 -X 'tcp and host 203.0.113.20 and port 443 and (tcp[tcpflags] & (tcp-push|tcp-fin|tcp-rst) != 0)' 2>&1 || true ;;
  *) exit 2 ;;
esac
