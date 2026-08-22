#!/usr/bin/env bash
#
# Build this fork of jellyfin-web on the Jellyfin server and deploy it as the
# active web client, replacing the apt-installed one at /usr/share/jellyfin/web.
#
# One-time server setup (see scripts/README-custom-deploy.md for detail):
#   1. Install Node 24 (NodeSource) + git + rsync.
#   2. git clone https://github.com/slickwarren/jellyfin-web.git ~/src/jellyfin-web
#   3. Run this script once (it creates ~/jellyfin-web/{releases,current}).
#   4. Install the systemd drop-in scripts/jellyfin-webdir.conf to
#      /etc/systemd/system/jellyfin.service.d/webdir.conf, then daemon-reload.
#
# Thereafter, redeploy with:  ~/src/jellyfin-web/scripts/deploy-jellyfin-web.sh
#
# Everything lives inside main() so bash parses the whole script up front; the
# script resets its own git repo mid-run, which would otherwise corrupt the
# incremental read of this file.

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SRC_DIR="${JELLYFIN_WEB_SRC:-$HOME/src/jellyfin-web}"
readonly TARGET_ROOT="${JELLYFIN_WEB_ROOT:-$HOME/jellyfin-web}"
readonly RELEASES_DIR="$TARGET_ROOT/releases"
readonly CURRENT_LINK="$TARGET_ROOT/current"
readonly KEEP_RELEASES=3
readonly BRANCH="${JELLYFIN_WEB_BRANCH:-master}"
readonly SERVICE="jellyfin.service"

# Node installed under the user's home (see README-custom-deploy.md) takes
# precedence over anything system-wide.
[ -d "$HOME/.local/node/bin" ] && PATH="$HOME/.local/node/bin:$PATH"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

check_prereqs() {
    command -v git >/dev/null || die "git is not installed"
    command -v rsync >/dev/null || die "rsync is not installed"
    command -v node >/dev/null || die "node is not installed (need Node 24+)"
    command -v npm >/dev/null || die "npm is not installed (need npm 11+)"

    local node_major
    node_major="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$node_major" -ge 24 ] || die "Node $node_major found, but this build needs Node 24+ (see .nvmrc)"

    [ -d "$SRC_DIR/.git" ] || die "$SRC_DIR is not a git checkout of jellyfin-web"
}

sync_source() {
    cd "$SRC_DIR"
    log "Fetching origin/$BRANCH"
    git fetch --prune origin "$BRANCH"
    # The fork-sync workflow rebases and force-pushes, so only a hard reset is
    # safe here; a merge/pull would conflict every week.
    git reset --hard "origin/$BRANCH"
    git clean -fd -e node_modules
    log "Building $(git describe --tags --always) ($(git log -1 --format=%s))"
}

build() {
    cd "$SRC_DIR"
    npm ci --no-audit
    JELLYFIN_VERSION="$(git describe --tags --always)" npm run build:production
}

verify_build() {
    cd "$SRC_DIR"
    local f
    for f in index.html main.jellyfin.bundle.js serviceworker.js config.json; do
        [ -s "dist/$f" ] || die "build looks broken: dist/$f is missing or empty"
    done
    local count
    count="$(find dist -type f | wc -l)"
    [ "$count" -ge 500 ] || die "build looks broken: only $count files in dist/"
    log "Build OK ($count files)"
}

install_release() {
    cd "$SRC_DIR"
    local release
    release="$RELEASES_DIR/$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"

    log "Installing to $release"
    mkdir -p "$release"
    rsync -a --delete dist/ "$release/"
    find "$release" -type d -exec chmod 755 {} +
    find "$release" -type f -exec chmod 644 {} +

    # Atomic symlink swap: ln -sfn on an existing symlink-to-dir would nest
    # inside it, so build the link elsewhere and mv -T over the old one.
    ln -sfn "$release" "$CURRENT_LINK.tmp"
    mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
    log "current -> $(readlink -f "$CURRENT_LINK")"
}

# The effective --webdir cannot be read from the unit: ExecStart stores the
# literal, unexpanded "$JELLYFIN_WEB_OPT". The only reliable source is the
# running process's own argv.
effective_webdir() {
    local pid
    pid="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null)"
    [ -n "$pid" ] && [ "$pid" != "0" ] || return 1
    tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null \
        | grep -m1 -oP '(?<=--webdir=).*'
}

# Fallback for when the service is stopped: read the configured value the same
# way systemd would -- later EnvironmentFile wins over earlier ones.
configured_webdir() {
    local f val=""
    for f in /etc/default/jellyfin /etc/default/jellyfin-webdir; do
        [ -r "$f" ] || continue
        local line
        line="$(grep -E '^JELLYFIN_WEB_OPT=' "$f" 2>/dev/null | tail -1)"
        [ -n "$line" ] && val="$line"
    done
    [ -n "$val" ] || return 1
    printf '%s' "$val" | sed 's/.*--webdir=//; s/"$//'
}

restart_server() {
    local active
    active="$(effective_webdir || configured_webdir || true)"
    if [ "$active" != "$CURRENT_LINK" ]; then
        log "NOTE: $SERVICE is serving ${active:-<unknown>}, not $CURRENT_LINK,"
        log "      so this build is staged but not live. To activate it:"
        log "        sudo install -Dm644 $SCRIPT_DIR/jellyfin-webdir.env /etc/default/jellyfin-webdir"
        log "        sudo install -Dm644 $SCRIPT_DIR/jellyfin-webdir.conf \\"
        log "          /etc/systemd/system/jellyfin.service.d/webdir.conf"
        log "        sudo systemctl daemon-reload && sudo systemctl restart jellyfin"
        return
    fi
    # sudo -n so an unattended/cron run reports instead of blocking on a prompt.
    if sudo -n systemctl restart "$SERVICE" 2>/dev/null; then
        log "Restarted $SERVICE"
        verify_serving
    else
        log "NOTE: could not restart $SERVICE without a password. Run:"
        log "        sudo systemctl restart jellyfin"
        log "      The new build is staged and current/ already points at it."
    fi
}

# Config can look right while the wrong directory is served (an earlier drop-in
# using Environment= was silently overridden by EnvironmentFile=). Compare what
# the server actually hands out against what we just installed.
verify_serving() {
    command -v curl >/dev/null || return 0
    local port want got i
    port="$(grep -oE '<InternalHttpPort>[0-9]+' /etc/jellyfin/network.xml 2>/dev/null \
        | grep -oE '[0-9]+' | head -1)"
    [ -n "$port" ] || port=8096
    want="$(md5sum "$CURRENT_LINK/index.html" 2>/dev/null | cut -d' ' -f1)"
    [ -n "$want" ] || return 0
    for i in $(seq 1 15); do
        got="$(curl -sf --max-time 5 "http://localhost:$port/web/index.html" 2>/dev/null \
            | md5sum | cut -d' ' -f1)"
        [ "$got" = "$want" ] && { log "Verified: the server is serving this build"; return 0; }
        sleep 2
    done
    log "WARNING: the server is NOT serving this build (index.html differs)."
    log "         served md5 ${got:-<none>} != built md5 $want"
    log "         Check: /etc/default/jellyfin-webdir and the webdir.conf drop-in."
    return 0
}

prune_releases() {
    local keeping
    keeping="$(readlink -f "$CURRENT_LINK")"
    local old
    # Newest KEEP_RELEASES survive; never remove whatever current points at.
    while read -r old; do
        [ -n "$old" ] || continue
        [ "$old" = "$keeping" ] && continue
        log "Pruning old release $(basename "$old")"
        rm -rf "$old"
    done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n "+$((KEEP_RELEASES + 1))")
}

main() {
    check_prereqs
    mkdir -p "$RELEASES_DIR"
    sync_source
    build
    verify_build
    install_release
    restart_server
    prune_releases
    log "Done. Hard-refresh the browser (or unregister the service worker) to pick up changes."
}

main "$@"
