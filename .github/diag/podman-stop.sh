#!/usr/bin/env bash
# Throwaway diagnostics for "rootless netns: kill network process: permission denied" when the
# last container leaves a network on rootless Podman (Ubuntu 26.04). Not part of AceSwarm.
set -uo pipefail

IMAGE=docker.io/library/alpine:3.22
STAMP="$RUNNER_TEMP/diag-stamp"

hr() { printf '\n========== %s ==========\n' "$*"; }
mark() { date +%s >"$STAMP"; }
denials() {
  hr "AppArmor messages since the mark"
  local since
  since="$(cat "$STAMP" 2>/dev/null || echo 0)"
  sudo journalctl -k --since "@$since" --no-pager -o short-precise | grep -i -E 'apparmor|audit' || echo "(none)"
}
procs() {
  hr "pasta/podman processes with their AppArmor labels"
  ps -eo pid,ppid,user,label:40,args | grep -E 'pasta|passt|slirp4netns|podman|conmon|rootlessport|aardvark' | grep -v -E 'grep|podman-stop.sh' || echo "(none)"
  local pid
  for pid in $(pgrep -u "$(id -u)" -x pasta.avx2; pgrep -u "$(id -u)" -x pasta; pgrep -u "$(id -u)" -x slirp4netns); do
    echo "pid $pid: $(tr '\0' ' ' <"/proc/$pid/cmdline")"
    echo "  label: $(cat "/proc/$pid/attr/apparmor/current" 2>/dev/null || cat "/proc/$pid/attr/current" 2>/dev/null)"
    echo "  exe:   $(readlink "/proc/$pid/exe")"
  done
  echo "this shell's label: $(cat /proc/self/attr/apparmor/current 2>/dev/null || cat /proc/self/attr/current)"
  hr "rootless netns state"
  ls -la "$XDG_RUNTIME_DIR/containers/networks/rootless-netns/" 2>&1
  local f
  for f in "$XDG_RUNTIME_DIR"/containers/networks/rootless-netns/*.pid "$XDG_RUNTIME_DIR"/containers/networks/rootless-netns/*-pid; do
    [[ -e "$f" ]] && echo "$f: $(cat "$f")"
  done
}
state() {
  hr "podman state"
  podman ps -a --format '{{.Names}} {{.Status}}' 2>&1
  podman network ls 2>&1
  podman volume ls 2>&1
}

info() {
  hr "versions"
  uname -a
  grep -E '^(PRETTY_NAME|VERSION_CODENAME)=' /etc/os-release
  dpkg-query -W -f '${Package} ${Version}\n' apparmor podman passt slirp4netns netavark aardvark-dns crun conmon docker-compose-v2 containers-common golang-github-containers-common 2>/dev/null
  podman version 2>&1 | head -20
  hr "AppArmor profiles that mention pasta, passt, slirp4netns, podman, crun or conmon"
  sudo aa-status 2>&1 | grep -E -i 'profiles|pasta|passt|slirp|podman|crun|conmon|wg|unconfined' | head -60
  local f
  for f in $(grep -l -E 'pasta|passt|slirp4netns|podman|crun|conmon' /etc/apparmor.d/* /etc/apparmor.d/abstractions/* 2>/dev/null | sort -u); do
    hr "$f"
    cat "$f"
  done
  hr "/etc/apparmor.d/local"
  ls -la /etc/apparmor.d/local/ 2>&1 | head -80
  hr "kernel AppArmor settings"
  for f in /proc/sys/kernel/apparmor_restrict_unprivileged_userns /proc/sys/kernel/apparmor_restrict_unprivileged_unconfined /proc/sys/kernel/unprivileged_userns_clone; do
    [[ -e "$f" ]] && echo "$f = $(cat "$f")"
  done
  hr "containers.conf network settings"
  grep -rn -E 'network_cmd|default_rootless_network_cmd|pasta_options|network_backend' /usr/share/containers/ /etc/containers/ 2>/dev/null | head -20
}

# Podman CLI: one container on a custom network, which runs in the rootless netns behind pasta.
cli() {
  local tag="$1"
  podman pull -q "$IMAGE" >/dev/null
  podman network create diagnet >/dev/null 2>&1 || true
  podman run -d --name d1 --network diagnet "$IMAGE" sleep 600 >/dev/null
  podman run -d --name d2 --network diagnet "$IMAGE" sleep 600 >/dev/null
  podman exec d1 ping -c 1 -W 3 1.1.1.1 >/dev/null 2>&1 && echo "d1 reaches 1.1.1.1" || echo "d1 can't ping 1.1.1.1"
  procs
  mark
  hr "[$tag] podman rm -f d2 (another container still on the network)"
  podman rm -f d2
  echo "exit $?"
  hr "[$tag] podman --log-level=debug rm -f d1 (the last container on the network)"
  podman --log-level=debug rm -f d1 2>&1 | grep -v -E 'level=debug msg="(Called|Setting|Initializing|Using|Merged|Overriding|Cached|Successfully loaded|Not modifying|Found|Checking|Enabling)' | tail -40
  echo "exit ${PIPESTATUS[0]}"
  denials
  sleep 5
  procs
  state
  hr "[$tag] a new container on the same network after that"
  mark
  podman run --rm --network diagnet "$IMAGE" ping -c 1 -W 3 1.1.1.1 2>&1 | tail -3
  echo "exit ${PIPESTATUS[0]}"
  denials
  procs
  podman network rm -f diagnet >/dev/null 2>&1
}

# docker compose through podman-docker, like `docker compose up` / `down` on the host.
compose() {
  local tag="$1" dir="$RUNNER_TEMP/diag-compose"
  mkdir -p "$dir"
  cat >"$dir/compose.yaml" <<EOF
services:
  a:
    image: $IMAGE
    command: sleep 600
    volumes: [data:/data]
  b:
    image: $IMAGE
    command: sleep 600
volumes:
  data:
EOF
  hr "[$tag] docker compose up"
  docker compose -p diag -f "$dir/compose.yaml" up -d 2>&1 | tail -10
  procs
  mark
  hr "[$tag] docker compose down --volumes --remove-orphans"
  docker compose -p diag -f "$dir/compose.yaml" down --volumes --remove-orphans 2>&1
  echo "exit ${PIPESTATUS[0]}"
  denials
  sleep 5
  procs
  state
  hr "[$tag] second up/down cycle"
  mark
  docker compose -p diag -f "$dir/compose.yaml" up -d 2>&1 | tail -10
  echo "up exit ${PIPESTATUS[0]}"
  docker compose -p diag -f "$dir/compose.yaml" exec -T a ping -c 1 -W 3 1.1.1.1 2>&1 | tail -2
  docker compose -p diag -f "$dir/compose.yaml" down --volumes --remove-orphans 2>&1 | tail -6
  echo "down exit ${PIPESTATUS[0]}"
  denials
  state
  # Clean up whatever is left, so the next experiment starts fresh.
  podman rm -a -f >/dev/null 2>&1
  podman network prune -f >/dev/null 2>&1
  podman volume prune -f >/dev/null 2>&1
}

# Experiment: give Ubuntu's pasta profile a local include (it has none) holding the one rule the
# denial asks for, as a host admin would.
override_on() {
  local profile=/etc/apparmor.d/usr.bin.pasta
  sudo cp "$profile" "$RUNNER_TEMP/usr.bin.pasta.orig"
  sudo sed -i 's|^}$|  include if exists <local/usr.bin.pasta>\n}|' "$profile"
  echo "signal (receive) set=(term) peer=podman," | sudo tee /etc/apparmor.d/local/usr.bin.pasta
  hr "$profile with the include"
  tail -5 "$profile"
  sudo apparmor_parser -r "$profile" && echo "reloaded $profile"
}
override_off() {
  sudo cp "$RUNNER_TEMP/usr.bin.pasta.orig" /etc/apparmor.d/usr.bin.pasta
  sudo truncate -s 0 /etc/apparmor.d/local/usr.bin.pasta
  sudo apparmor_parser -r /etc/apparmor.d/usr.bin.pasta && echo "restored the packaged profile"
}

# Experiment: no AppArmor profile for pasta at all.
disable_on() {
  sudo ln -sf /etc/apparmor.d/usr.bin.pasta /etc/apparmor.d/disable/usr.bin.pasta
  sudo apparmor_parser -R /etc/apparmor.d/usr.bin.pasta && echo "unloaded the pasta profile"
  sudo aa-status 2>&1 | grep -E 'pasta' || echo "no pasta profile loaded"
}

# Experiment: slirp4netns instead of pasta for the rootless netns.
slirp_on() {
  sudo DEBIAN_FRONTEND=noninteractive timeout 300 apt-get install -y -qq slirp4netns >/dev/null
  dpkg-query -W -f '${Package} ${Version}\n' slirp4netns
  mkdir -p ~/.config/containers
  printf '[network]\ndefault_rootless_network_cmd = "slirp4netns"\n' >~/.config/containers/containers.conf
  podman info --format 'rootless-network={{.Host.RootlessNetworkCmd}}'
}

case "${1:-}" in
  info) info ;;
  cli) cli "${2:-baseline}" ;;
  compose) compose "${2:-baseline}" ;;
  override-on) override_on ;;
  override-off) override_off ;;
  slirp-on) slirp_on ;;
  disable-on) disable_on ;;
  *)
    echo "usage: $0 info|cli TAG|compose TAG|override-on|override-off|disable-on|slirp-on" >&2
    exit 2
    ;;
esac
exit 0
