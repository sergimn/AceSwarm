#!/usr/bin/env bash
# Rootless Podman for the stack runner of the Podman E2E leg (see e2e/README.md), set up like a
# host that runs AceSwarm with `docker compose up` on Podman: podman-docker makes `docker` run
# Podman, `docker compose` becomes `podman compose` with Docker Compose (docker-compose-v2) as its
# provider, and the stack's docker-proxy uses this user's Podman API socket (DOCKER_SOCKET).
#
#   e2e/podman.sh setup     install and start; writes the environment to $GITHUB_ENV when set
#   e2e/podman.sh iptables  ARGS...   iptables in rootless Podman's network namespace
set -euo pipefail

log() { printf '[podman %s] %s\n' "$(date +%T)" "$*" >&2; }

apt_install() {
  # Bounded: a hung apt must not hold the runner for the job's whole timeout.
  sudo timeout 300 apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive timeout 600 apt-get install -y -qq "$@" >/dev/null
}

setup() {
  local uid user
  uid="$(id -u)"
  user="$(id -un)"
  if [[ "$uid" == 0 ]]; then
    log "run this as the unprivileged user that should own the containers"
    exit 2
  fi

  # The distribution's packages, as on an Ubuntu host: podman-docker replaces /usr/bin/docker, and
  # docker-compose-v2 is the provider `podman compose` finds. Docker's own packages go first, since
  # they own the same files.
  sudo systemctl stop docker.socket docker.service 2>/dev/null || true
  local file package packages=()
  for file in /usr/bin/docker /usr/libexec/docker/cli-plugins/docker-compose; do
    if package="$(dpkg -S "$file" 2>/dev/null)"; then
      packages+=("${package%%:*}")
    fi
  done
  if ((${#packages[@]} > 0)); then
    sudo DEBIAN_FRONTEND=noninteractive timeout 300 apt-get remove -y -qq "${packages[@]}" >/dev/null
  fi
  apt_install podman podman-docker docker-compose-v2 passt uidmap
  # podman-docker prints a notice on every call without it.
  sudo touch /etc/containers/nodocker
  if ! grep -q "^${user}:" /etc/subuid || ! grep -q "^${user}:" /etc/subgid; then
    sudo usermod --add-subuids 200000-265535 --add-subgids 200000-265535 "$user"
  fi
  # The specs' iptables rules in Podman's network namespace can't load kernel modules from there.
  sudo modprobe -a nft_compat xt_comment xt_tcpudp 2>/dev/null || true

  # A systemd user instance, as on a desktop or a lingering server user: Podman's systemd cgroup
  # manager, its healthcheck timers (compose waits on them) and the API socket unit need it.
  sudo loginctl enable-linger "$user"
  export XDG_RUNTIME_DIR="/run/user/${uid}"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  local deadline=$((SECONDS + 60))
  until [[ -S "${XDG_RUNTIME_DIR}/bus" ]]; do
    ((SECONDS < deadline)) || {
      log "the systemd user instance did not start"
      exit 1
    }
    sleep 1
  done
  podman system migrate
  systemctl --user start podman.socket
  local socket="${XDG_RUNTIME_DIR}/podman/podman.sock"
  deadline=$((SECONDS + 60))
  until curl -sf --unix-socket "$socket" http://podman/_ping >/dev/null; do
    ((SECONDS < deadline)) || {
      log "the Podman API socket does not answer"
      exit 1
    }
    sleep 1
  done

  docker version
  podman info --format 'rootless={{.Host.Security.Rootless}} cgroups={{.Host.CgroupManager}}/{{.Host.CgroupsVersion}} network={{.Host.NetworkBackend}} rootless-network={{.Host.RootlessNetworkCmd}} runtime={{.Host.OCIRuntime.Name}} apparmor={{.Host.Security.AppArmorEnabled}}'
  PODMAN_COMPOSE_WARNING_LOGS=false docker compose version

  if [[ -n "${GITHUB_ENV:-}" ]]; then
    {
      echo "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}"
      echo "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS}"
      # `podman compose` says which provider it runs on every call.
      echo "PODMAN_COMPOSE_WARNING_LOGS=false"
      # The socket the stack's docker-proxy mounts, as .env.example documents for rootless Podman.
      echo "DOCKER_SOCKET=${socket}"
      # Podman needs an internal engines network (compose.yaml).
      echo "ACESWARM_ENGINES_INTERNAL=true"
      echo "E2E_RUNTIME=podman"
    } >>"$GITHUB_ENV"
  fi
}

case "${1:-}" in
  setup) setup ;;
  iptables)
    shift
    # Rootless containers reach the outside through this namespace, so its FORWARD chain sees what
    # DOCKER-USER sees on a Docker host: container traffic only, not the runner's own.
    exec podman unshare --rootless-netns iptables "$@"
    ;;
  *)
    echo "usage: $0 setup|iptables ARGS..." >&2
    exit 2
    ;;
esac
