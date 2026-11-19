#!/usr/local/lib/aceswarm/busybox sh
# Routes all engine traffic through the AceSwarm network gateway, then drops root and every
# capability (NET_ADMIN is only granted for the route change) before starting the engine. The
# engine therefore cannot change its own routes to bypass the gateway.
#
# BusyBox runs this script, so that it behaves the same in both engine images, whatever their
# /bin/sh is.
set -eu

bb=/usr/local/lib/aceswarm/busybox

if [ -n "${ACESWARM_GATEWAY:-}" ]; then
  "$bb" ip route replace default via "$ACESWARM_GATEWAY"
  # The gateway only routes IPv4. An IPv6 default route (if the network has IPv6) would bypass it.
  "$bb" ip -6 route flush default 2>/dev/null || true
fi

# Engines sit on an internal network where Docker's DNS does not resolve outside names, so DNS
# goes to public resolvers through the gateway (and therefore through the stream's network path).
if [ -n "${ACESWARM_DNS:-}" ]; then
  for server in $(echo "$ACESWARM_DNS" | tr ',' ' '); do
    echo "nameserver $server"
  done > /etc/resolv.conf
fi

user="${ACESWARM_ENGINE_USER:-1000:1000}"

# Cache on disk (ENGINE_CACHE_DIR). The host folder is mounted at /cache in every engine, and each
# engine container gets a folder of its own in it:
#
#   /cache/engine-<container>/.aceswarm-lock   locked for as long as the container runs
#   /cache/engine-<container>/data             the engine's cache folder, owned by its user
#
# Nothing else can tell this script which engines are gone, so the lock does: the kernel drops it
# when the container's last process ends, however it ends. An engine that starts removes every
# folder whose lock is free. The folders and their locks belong to root, so the engine's user can
# change neither: it can only write inside the data folders.
cache_root=/cache
lock_name=.aceswarm-lock

cache_fail() {
  echo "engine cache on disk: $*" >&2
  # 78 is EX_CONFIG: the setup is wrong, and a restart cannot fix it.
  exit 78
}

# Removes the folders of engines that no longer run. Each one is handled in a subshell, which holds
# the lock while it works and lets go of it when it ends. The folder is renamed before it is
# deleted: a rename happens at once, so an engine that starts under the same name meanwhile makes a
# new folder and never sees its files vanish halfway.
remove_dead_caches() {
  count=0
  for dir in "$cache_root"/engine-*; do
    if [ -L "$dir" ] || [ ! -f "$dir/$lock_name" ]; then
      continue
    fi
    count=$((count + 1))
    doomed="$cache_root/.aceswarm-removing-$("$bb" hostname)-$count"
    # The steps are joined with &&, because "set -e" does not stop a subshell that is part of
    # a || list. The folder may have been removed and made again since the lock file was opened:
    # only a lock on the file that is there now says that nobody uses the folder.
    (
      exec 8<> "$dir/$lock_name" &&
        "$bb" flock -n 8 &&
        "$bb" test "$dir/$lock_name" -ef /proc/self/fd/8 &&
        "$bb" mv "$dir" "$doomed"
    ) 2>/dev/null || true
  done
  # Also what an engine that was killed in the middle of this left behind.
  for doomed in "$cache_root"/.aceswarm-removing-*; do
    if [ -d "$doomed" ] && [ ! -L "$doomed" ]; then
      "$bb" rm -rf "$doomed" 2>/dev/null || true
    fi
  done
}

# Makes this container's folder and takes its lock on file descriptor 9, which the engine inherits
# and so keeps open for as long as it runs.
claim_cache() {
  own="$cache_root/engine-$("$bb" hostname)"
  attempt=0
  while :; do
    "$bb" mkdir -p "$own" || cache_fail "cannot make $own. The container runtime has to be able to" \
      "write to the folder ENGINE_CACHE_DIR names (with rootless Docker or Podman, as the user it" \
      "runs as), and on a host with SELinux the folder needs a label that containers may use."
    exec 9<> "$own/$lock_name"
    # Another engine that is starting may have taken this folder for a dead one's and be removing
    # it right now. It lets go within moments, so try again.
    if "$bb" flock -n 9 && "$bb" test "$own/$lock_name" -ef /proc/self/fd/9; then
      break
    fi
    exec 9<&-
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 10 ]; then
      cache_fail "cannot lock $own/$lock_name"
    fi
    "$bb" sleep 1
  done
  # A container that restarts starts from an empty cache, like a new one.
  "$bb" rm -rf "$own/data"
  "$bb" mkdir "$own/data"
  "$bb" chown "$user" "$own/data" 2>/dev/null || true
  if ! "$bb" chpst -u "$user" "$bb" test -w "$own/data"; then
    cache_fail "the engine's user ($user) cannot write to $own/data. The folder ENGINE_CACHE_DIR" \
      "names has to be on a filesystem that keeps Linux owners and permissions (ext4, not FAT or" \
      "exFAT), and on a host with SELinux it needs a label that containers may use."
  fi
  export ACESWARM_CACHE_DIR="$own/data"
}

case "${ACESWARM_DISK_CACHE_BYTES:-0}" in
  *[!0-9]*)
    echo "ACESWARM_DISK_CACHE_BYTES must be a number of bytes, got '$ACESWARM_DISK_CACHE_BYTES'" >&2
    exit 64
    ;;
  *[!0]*)
    if ! "$bb" mountpoint -q "$cache_root"; then
      cache_fail "ACESWARM_DISK_CACHE_BYTES is set, but no folder is mounted at $cache_root"
    fi
    remove_dead_caches
    claim_cache
    ;;
esac

# chpst switches to an unprivileged user, which clears every capability; setpriv --nnp makes sure
# none can be regained through setuid binaries or file capabilities.
exec "$bb" setpriv --nnp "$bb" chpst -u "$user" \
  /usr/local/lib/aceswarm/start-engine "$@"
