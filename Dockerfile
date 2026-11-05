# syntax=docker/dockerfile:1
#
# Images for the AceSwarm services, one target each: controller (API + UI), transcoder and netgw.
# The engine image is engine/Dockerfile. Dependencies and the UI build run on the build machine's
# platform, so a multi-arch build only emulates the small `apk add` of the network gateway.

ARG NODE_IMAGE=docker.io/library/node:26.13.0-alpine3.23@sha256:e6c03d42b46af3b1e98207e59f06a43cfe5efd3ec4b4d3d9802bddf04f833374

FROM docker.io/mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b AS ffmpeg

# Builds behind a TLS-inspecting proxy can pass its CA bundle as an optional secret:
#   docker build --secret id=build_ca,src=/path/to/ca-bundle.crt ...

# ---- Dependencies (platform independent: every dependency is plain JavaScript) ----------------

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/controller/package.json apps/controller/
COPY apps/transcoder/package.json apps/transcoder/
COPY apps/netgw/package.json apps/netgw/
COPY apps/ui/package.json apps/ui/
RUN mkdir -p /out/data/wireguard /out/hls

FROM manifests AS ui
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund --workspace @aceswarm/ui
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/ui apps/ui
RUN npm run build --workspace @aceswarm/ui

FROM manifests AS controller-deps
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund --omit=dev --workspace @aceswarm/controller

FROM manifests AS transcoder-deps
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund --omit=dev --workspace @aceswarm/transcoder

FROM manifests AS netgw-deps
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund --omit=dev --workspace @aceswarm/netgw

# ---- Runtime images ---------------------------------------------------------------------------

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/src packages/shared/src

FROM runtime AS controller
COPY --from=controller-deps /app/node_modules node_modules
COPY apps/controller/package.json apps/controller/
COPY apps/controller/src apps/controller/src
COPY --from=ui /app/apps/controller/public apps/controller/public
COPY --from=manifests --chown=node:node /out/data /data
WORKDIR /app/apps/controller
# The node image's "node" user.
USER 1000:1000
EXPOSE 8080
CMD ["node", "src/main.ts"]

FROM runtime AS transcoder
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=transcoder-deps /app/node_modules node_modules
COPY apps/transcoder/package.json apps/transcoder/
COPY apps/transcoder/src apps/transcoder/src
COPY --from=manifests --chown=node:node /out/hls /hls
WORKDIR /app/apps/transcoder
# The node image's "node" user.
USER 1000:1000
EXPOSE 8081
CMD ["node", "src/main.ts"]

# The gateway needs root (NET_ADMIN) to manage WireGuard interfaces, routes and iptables rules.
FROM runtime AS netgw
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    apk add --no-cache \
      conntrack-tools \
      iproute2 \
      iptables \
      iptables-legacy \
      iputils-ping \
      wireguard-go \
      wireguard-tools-wg
COPY --from=netgw-deps /app/node_modules node_modules
COPY apps/netgw/package.json apps/netgw/
COPY apps/netgw/src apps/netgw/src
WORKDIR /app/apps/netgw
EXPOSE 8082
# Fail closed before anything else runs. The network namespace starts with forwarding on (the
# ip_forward sysctl) and an ACCEPT policy, and Node.js takes a moment to start.
CMD ["/bin/sh", "-c", "\"${IPTABLES:-iptables}\" -P FORWARD DROP && exec node src/main.ts"]
