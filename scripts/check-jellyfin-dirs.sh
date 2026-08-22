#!/usr/bin/env bash
#
# Verify the user Jellyfin actually runs as can write every directory it needs.
#
# Why this exists: this server runs Jellyfin as `slickwarren` via User= in
# /etc/systemd/system/jellyfin.service.d/jellyfin.service.conf, but the packages
# create /var/lib, /etc, /var/log and /var/cache under the `jellyfin` user. Three
# of those were re-owned when the service user was changed; /var/cache/jellyfin
# was missed. 10.11 never wrote to the cache root so it never mattered -- until
# the 12.0 nightly, which writes CACHEDIR.TAG there on every start and aborts
# with UnauthorizedAccessException if it cannot.
#
# A package upgrade can reset ownership again, so run this after any
# jellyfin upgrade, and before starting the service.
#
# Usage:  bash ~/bin/check-jellyfin-dirs.sh
# Exits non-zero and prints the fix if anything is not writable.

set -uo pipefail

DEFAULTS="/etc/default/jellyfin"
SVC_USER="$(systemctl show jellyfin -p User --value 2>/dev/null)"
[ -n "$SVC_USER" ] || SVC_USER="jellyfin"

echo "Jellyfin runs as: $SVC_USER"

# Read the directory list from the packaged defaults rather than hardcoding it.
DIRS=""
for var in JELLYFIN_DATA_DIR JELLYFIN_CONFIG_DIR JELLYFIN_LOG_DIR JELLYFIN_CACHE_DIR; do
    val="$(grep -E "^${var}=" "$DEFAULTS" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')"
    [ -n "$val" ] && DIRS="$DIRS $val"
done
[ -n "$DIRS" ] || DIRS="/var/lib/jellyfin /etc/jellyfin /var/log/jellyfin /var/cache/jellyfin"

# Test as the service user where we can. Running as that user, test directly;
# as root, drop to it; otherwise fall back to an ownership heuristic and say so.
writable_as_svc_user() {
    local d="$1"
    if [ "$(id -un)" = "$SVC_USER" ]; then
        [ -w "$d" ]
    elif [ "$(id -u)" -eq 0 ]; then
        runuser -u "$SVC_USER" -- test -w "$d" 2>/dev/null
    else
        [ "$(stat -c %U "$d" 2>/dev/null)" = "$SVC_USER" ]
    fi
}

FAILED=""
for d in $DIRS; do
    if [ ! -d "$d" ]; then
        printf '  MISSING    %s\n' "$d"
        FAILED="$FAILED $d"
        continue
    fi
    if writable_as_svc_user "$d"; then
        printf '  ok         %s (%s)\n' "$d" "$(stat -c '%U:%G %a' "$d")"
    else
        printf '  NOT WRITABLE %s (%s)\n' "$d" "$(stat -c '%U:%G %a' "$d")"
        FAILED="$FAILED $d"
    fi
done

if [ "$(id -un)" != "$SVC_USER" ] && [ "$(id -u)" -ne 0 ]; then
    echo "  (note: not running as $SVC_USER or root -- checked ownership only, not real write access)"
fi

if [ -n "$FAILED" ]; then
    echo
    echo "FAIL: Jellyfin will not start with these permissions. Fix with:"
    # shellcheck disable=SC2086
    echo "    sudo chown -R $SVC_USER:$SVC_USER$FAILED"
    exit 1
fi

echo "All directories writable by $SVC_USER."
