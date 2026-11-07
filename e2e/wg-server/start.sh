#!/bin/sh
# Generates a server key pair and one key pair per client, brings wg0 up and NATs client traffic
# to the other networks. Each client's profile is written to /state/NAME.conf for the tests to
# upload: one per AceSwarm runner, since two clients can't share a key.
#
# WG_CLIENTS lists the client names (default: client), WG_ENDPOINT (host:port) is the endpoint
# written into the profiles, and WG_CLIENT_MTU adds an MTU line. The tests reach the server
# through another tunnel (the mesh), hence the smaller MTU.
set -eu
umask 077
mkdir -p /state
[ -f /state/server.key ] || wg genkey > /state/server.key
server_pub=$(wg pubkey < /state/server.key)
endpoint="${WG_ENDPOINT:?set WG_ENDPOINT to the host:port clients reach this server on}"
mtu_line=""
[ -z "${WG_CLIENT_MTU:-}" ] || mtu_line="MTU = ${WG_CLIENT_MTU}"

ip link del wg0 2>/dev/null || true
if ! ip link add wg0 type wireguard 2>/dev/null; then
  echo "kernel WireGuard not available, using wireguard-go"
  wireguard-go wg0
fi
wg set wg0 listen-port 51820 private-key /state/server.key

host=2
for name in ${WG_CLIENTS:-client}; do
  [ -f "/state/$name.key" ] || wg genkey > "/state/$name.key"
  cat > "/state/$name.conf" <<CONF
[Interface]
PrivateKey = $(cat "/state/$name.key")
Address = 10.13.13.$host/32
DNS = 1.1.1.1
${mtu_line}

[Peer]
PublicKey = ${server_pub}
Endpoint = ${endpoint}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 15
CONF
  chmod 0644 "/state/$name.conf"
  wg set wg0 peer "$(wg pubkey < "/state/$name.key")" allowed-ips "10.13.13.$host/32"
  host=$((host + 1))
done

ip address add 10.13.13.1/24 dev wg0
ip link set wg0 mtu "${WG_CLIENT_MTU:-1420}" up
iptables -t nat -A POSTROUTING -s 10.13.13.0/24 ! -o wg0 -j MASQUERADE
echo "wireguard server ready on ${endpoint}"
exec sleep infinity
