#!/bin/sh
# Routes all engine traffic through the AceSwarm network gateway, then drops root and every
# capability (NET_ADMIN is only granted for the route change) before starting the engine. The
# engine therefore cannot change its own routes to bypass the gateway.
set -eu

bb=/usr/local/lib/aceswarm/busybox

if [ -n "${ACESWARM_GATEWAY:-}" ]; then
  "$bb" ip route replace default via "$ACESWARM_GATEWAY"
fi

# Engines sit on an internal network where Docker's DNS does not resolve outside names, so DNS
# goes to public resolvers through the gateway (and therefore through the stream's network path).
if [ -n "${ACESWARM_DNS:-}" ]; then
  for server in $(echo "$ACESWARM_DNS" | tr ',' ' '); do
    echo "nameserver $server"
  done > /etc/resolv.conf
fi

# chpst switches to an unprivileged user, which clears every capability; setpriv --nnp makes sure
# none can be regained through setuid binaries or file capabilities.
exec "$bb" setpriv --nnp "$bb" chpst -u "${ACESWARM_ENGINE_USER:-1000:1000}" \
  /usr/local/lib/aceswarm/start-engine "$@"
