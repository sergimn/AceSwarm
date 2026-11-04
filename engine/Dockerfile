# syntax=docker/dockerfile:1
#
# Acestream engine image used by AceSwarm (one container per stream, created by the controller).
#
#  - linux/amd64: the official Linux build (3.2.11), packaged by martinbjeldbak/acestream-http-proxy.
#  - linux/arm64: the Android build (3.2.17) wrapped for Linux by jopsis/acestream. On a Raspberry Pi
#    it needs a kernel with 4 KB pages (see docs/raspberry-pi.md).
#
# Both variants share one entrypoint: it points the default route at the AceSwarm network gateway,
# then drops root and every capability before the engine starts. Nothing here runs at build time,
# so the multi-arch build needs no emulation.

FROM docker.io/library/busybox:1.37.0-musl@sha256:f6a95d611e0a8780fabdb2aec43e31275b2720dfefa3e41b16835bfc42454478 AS busybox

FROM ghcr.io/martinbjeldbak/acestream-http-proxy:3.5.1@sha256:2679f0473013d1b73ca56c77866ab77f4fd8874012d3f7c36b43c5adf6a8bdca AS engine-amd64
COPY --chmod=0755 engine/start-amd64.sh /usr/local/lib/aceswarm/start-engine

FROM docker.io/jopsis/acestream:v3.2.17-fix@sha256:506c4215115d8b0ac1e24f4c67c954f0dbf86e4b4ea508582e497d8c920e9933 AS engine-arm64
COPY --chmod=0755 engine/start-arm64.sh /usr/local/lib/aceswarm/start-engine

# hadolint ignore=DL3006
FROM engine-${TARGETARCH}
USER root
COPY --from=busybox /bin/busybox /usr/local/lib/aceswarm/busybox
COPY --chmod=0755 engine/entrypoint.sh /usr/local/lib/aceswarm/entrypoint.sh
ENV ACESWARM_ENGINE_USER=1000:1000 \
    ACESWARM_LIVE_CACHE_BYTES=104857600 \
    ACESWARM_ENGINE_FLAGS=""
EXPOSE 6878
ENTRYPOINT ["/usr/local/lib/aceswarm/entrypoint.sh"]
CMD []
