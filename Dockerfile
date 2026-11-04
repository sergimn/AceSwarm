# syntax=docker/dockerfile:1
#
# Images for the AceSwarm services, one target each: controller (API + UI), transcoder, netgw and
# mock-engine (tests only). Dependencies and the UI build run on the build machine's platform, so a
# multi-arch build only emulates the small `apk add` of the network gateway.

ARG NODE_IMAGE=docker.io/library/node:26.13.0-alpine3.23@sha256:e6c03d42b46af3b1e98207e59f06a43cfe5efd3ec4b4d3d9802bddf04f833374

FROM docker.io/mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b AS ffmpeg
FROM docker.io/library/busybox:1.37.0-musl@sha256:f6a95d611e0a8780fabdb2aec43e31275b2720dfefa3e41b16835bfc42454478 AS busybox

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
COPY apps/mock-engine/package.json apps/mock-engine/
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

FROM manifests AS mock-engine-deps
RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund --omit=dev --workspace @aceswarm/mock-engine

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
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]

FROM runtime AS transcoder
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=transcoder-deps /app/node_modules node_modules
COPY apps/transcoder/package.json apps/transcoder/
COPY apps/transcoder/src apps/transcoder/src
COPY --from=manifests --chown=node:node /out/hls /hls
WORKDIR /app/apps/transcoder
USER node
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
CMD ["node", "src/main.ts"]

# Fake Acestream engine for development and end-to-end tests. It uses the same entrypoint as the
# real engine image, so the tests also cover routing through the gateway and dropping privileges.
FROM runtime AS mock-engine
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=busybox /bin/busybox /usr/local/lib/aceswarm/busybox
COPY --from=mock-engine-deps /app/node_modules node_modules
COPY apps/mock-engine/package.json apps/mock-engine/
COPY apps/mock-engine/src apps/mock-engine/src
COPY --chmod=0755 engine/entrypoint.sh /usr/local/lib/aceswarm/entrypoint.sh
COPY --chmod=0755 apps/mock-engine/start-engine.sh /usr/local/lib/aceswarm/start-engine
# Test peers can be baked in: the controller only passes ACESWARM_* variables to engines.
ARG MOCK_PEERS=""
ARG MOCK_VPN_PEERS=""
ENV ACESWARM_ENGINE_USER=1000:1000 \
    MOCK_PEERS=${MOCK_PEERS} \
    MOCK_VPN_PEERS=${MOCK_VPN_PEERS}
EXPOSE 6878
ENTRYPOINT ["/usr/local/lib/aceswarm/entrypoint.sh"]
