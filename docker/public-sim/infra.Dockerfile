# Routers and DNS of the simulated public host (#63). Local test infrastructure only.
FROM alpine:3.21
RUN apk add --no-cache iptables iproute2 iproute2-tc dnsmasq openssl tcpdump
