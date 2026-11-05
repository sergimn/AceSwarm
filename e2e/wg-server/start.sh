#!/bin/sh
# Generates a server and a client key pair, brings wg0 up and NATs client traffic to the other
# networks. The client profile is written to /state/client.conf for the tests to upload.
#
# WG_ENDPOINT (host:port) overrides the endpoint written into the profile, and WG_CLIENT_MTU adds an
# MTU line; the multi-machine tests use both because the server is reached through another tunnel.
set -eu
umask 077
mkdir -p /state
[ -f /state/server.key ] || wg genkey > /state/server.key
[ -f /state/client.key ] || wg genkey > /state/client.key
server_pub=$(wg pubkey < /state/server.key)
client_pub=$(wg pubkey < /state/client.key)
endpoint="${WG_ENDPOINT:-$(ip -4 -o addr show | awk '/198\.51\.100\./ { split($4, a, "/"); print a[1] }'):51820}"
mtu_line=""
[ -z "${WG_CLIENT_MTU:-}" ] || mtu_line="MTU = ${WG_CLIENT_MTU}"

cat > /state/client.conf <<CONF
[Interface]
PrivateKey = $(cat /state/client.key)
Address = 10.13.13.2/32
DNS = 1.1.1.1
${mtu_line}

[Peer]
PublicKey = ${server_pub}
Endpoint = ${endpoint}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 15
CONF
chmod 0644 /state/client.conf

ip link del wg0 2>/dev/null || true
if ! ip link add wg0 type wireguard 2>/dev/null; then
  echo "kernel WireGuard not available, using wireguard-go"
  wireguard-go wg0
fi
wg set wg0 listen-port 51820 private-key /state/server.key peer "$client_pub" allowed-ips 10.13.13.2/32
ip address add 10.13.13.1/24 dev wg0
ip link set wg0 mtu "${WG_CLIENT_MTU:-1420}" up
iptables -t nat -A POSTROUTING -s 10.13.13.0/24 ! -o wg0 -j MASQUERADE
echo "wireguard server ready on ${endpoint}"
exec sleep infinity
