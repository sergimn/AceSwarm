# syntax=docker/dockerfile:1
# Throwaway WireGuard server for the end-to-end tests only.
FROM docker.io/library/alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    apk add --no-cache iproute2 iptables wireguard-go wireguard-tools-wg
COPY --chmod=0755 start.sh /usr/local/bin/start.sh
CMD ["/usr/local/bin/start.sh"]
