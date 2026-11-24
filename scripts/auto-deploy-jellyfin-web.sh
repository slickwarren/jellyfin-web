#!/usr/bin/env bash
#
# Weekly unattended deploy, run on Monday mornings by jellyfin-web-deploy.timer.
# Skips when the fork's master is already deployed, or when its major version no
# longer matches the Jellyfin server's (they must match; see README-custom-deploy.md).
# Otherwise runs deploy-jellyfin-web.sh, which builds, installs and restarts Jellyfin.

set -euo pipefail

readonly SRC_DIR="${JELLYFIN_WEB_SRC:-$HOME/src/jellyfin-web}"
readonly CURRENT_LINK="${JELLYFIN_WEB_ROOT:-$HOME/jellyfin-web}/current"
readonly DEPLOY="$HOME/bin/deploy-jellyfin-web.sh"
readonly SERVER_URL="http://localhost:8096"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

main() {
    git -C "$SRC_DIR" fetch --quiet --prune origin master || die "git fetch failed"

    local new deployed web server
    new="$(git -C "$SRC_DIR" rev-parse origin/master)"
    # Release directories end in the short hash of the commit they were built from
    deployed="$(basename "$(readlink -f "$CURRENT_LINK")" | grep -oE '[0-9a-f]{7,}$' || true)"
    if [ -n "$deployed" ] && [[ "$new" == "$deployed"* ]]; then
        log "Nothing new: ${new:0:10} is already deployed."
        return
    fi

    web="$(git -C "$SRC_DIR" show origin/master:package.json | grep -m1 -oP '"version":\s*"\K[^"]+')"
    server="$(curl -sf --max-time 10 "$SERVER_URL/System/Info/Public" | grep -oP '"Version":"\K[^"]+')" \
        || die "could not read the Jellyfin server's version from $SERVER_URL"
    if [ "${web%%.*}" != "${server%%.*}" ]; then
        log "Skipping: fork master is web $web but the server is $server; their major versions must match."
        return
    fi

    log "Deploying ${new:0:10} (web $web, server $server)"
    "$DEPLOY"
}

main "$@"
