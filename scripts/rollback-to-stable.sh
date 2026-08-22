#!/usr/bin/env bash
#
# Roll back the unstable/12.0 upgrade: restore stable 10.11.11 packages and the
# pre-upgrade database.
#
# RUN WITH: sudo bash ~/bin/rollback-to-stable.sh <STAMP>
#   where <STAMP> is the timestamp printed by upgrade-to-unstable.sh, e.g.
#   20260822-051252. Run without arguments to list the available backups.
#
# WHAT THIS CANNOT DO: it restores the database as it was before the upgrade.
# Anything watched, added, or changed while running 12.0 is lost. This is a
# restore, not an undo.
#
# The 12.0 data directory is MOVED ASIDE, not deleted, so nothing is destroyed
# and you can dig through it afterwards.

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }

BACKUP_DIR="/home/slickwarren/jellyfin-backups"
SOURCES="/etc/apt/sources.list.d/jellyfin.sources"

if [ $# -lt 1 ]; then
    echo "Available backups:"
    ls -1 "$BACKUP_DIR"/jellyfin-pre-12.0-*.tar.gz 2>/dev/null \
        | sed 's/.*jellyfin-pre-12.0-/    /; s/\.tar\.gz$//' || echo "    (none)"
    echo
    echo "Usage: sudo bash $0 <STAMP>"
    exit 1
fi

STAMP="$1"
BACKUP="$BACKUP_DIR/jellyfin-pre-12.0-$STAMP.tar.gz"
MANIFEST="$BACKUP_DIR/jellyfin-pre-12.0-$STAMP.manifest"
SOURCES_BAK="$BACKUP_DIR/jellyfin.sources.bak-$STAMP"
ASIDE="/var/lib/jellyfin.12.0-$(date -u +%Y%m%d-%H%M%S)"

[ -f "$BACKUP" ] || { echo "No such backup: $BACKUP" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "No such manifest: $MANIFEST" >&2; exit 1; }

echo "==> Backup:   $BACKUP ($(du -h "$BACKUP" | cut -f1))"
echo "==> Restoring these package versions:"
sed 's/^/    /' "$MANIFEST"
echo "==> Live data will be moved aside to $ASIDE (not deleted)"
echo
read -r -p "Proceed with rollback? Post-upgrade changes WILL be lost. [y/N] " reply
[ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "Aborted."; exit 1; }

echo "==> Verifying the backup before touching anything"
gzip -t "$BACKUP"
tar -tzf "$BACKUP" var/lib/jellyfin/data/jellyfin.db >/dev/null
echo "    backup verified"

echo "==> Stopping jellyfin"
# See upgrade-to-unstable.sh: the stop routinely exceeds TimeoutStopSec and the
# unit ends up "failed", which makes systemctl return non-zero.
systemctl stop jellyfin || true
for _ in $(seq 1 30); do
    systemctl is-active --quiet jellyfin || break
    sleep 1
done
if systemctl is-active --quiet jellyfin; then
    echo "ERROR: jellyfin is still running after 30s; refusing to restore over a live database." >&2
    exit 1
fi
systemctl reset-failed jellyfin 2>/dev/null || true

echo "==> Restoring the stable-only apt source"
if [ -f "$SOURCES_BAK" ]; then
    cp -a "$SOURCES_BAK" "$SOURCES"
else
    sed -i 's/^Components: main unstable$/Components: main/' "$SOURCES"
fi
grep '^Components:' "$SOURCES"
apt-get update -qq

echo "==> Downgrading packages"
# jellyfin-ffmpeg7 is explicit here because jellyfin-ffmpeg8 Conflicts/Replaces
# it -- the upgrade removed it, and the 10.11.11 metapackage depends on it.
PKGS=""
while IFS= read -r line; do
    case "$line" in
        jellyfin=*|jellyfin-server=*|jellyfin-web=*|jellyfin-ffmpeg7=*) PKGS="$PKGS $line" ;;
    esac
done < "$MANIFEST"
echo "    installing:$PKGS"
# shellcheck disable=SC2086
DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades \
    -o Dpkg::Options::=--force-confold \
    -o Dpkg::Options::=--force-confdef \
    $PKGS

echo "==> Moving the 12.0 data aside and restoring the pre-upgrade data"
# Move rather than extract-over, so files that 12.0 created but 10.11 never had
# cannot linger and confuse the older server.
mv /var/lib/jellyfin "$ASIDE"
mv /etc/jellyfin "$ASIDE.etc"
tar -xzf "$BACKUP" -C /

echo "==> Putting the regenerable caches back (they were excluded from the backup)"
for d in subtitles trickplay attachments; do
    if [ -d "$ASIDE/data/$d" ]; then
        mv "$ASIDE/data/$d" "/var/lib/jellyfin/data/$d"
        echo "    restored data/$d"
    fi
done
chown -R slickwarren:slickwarren /var/lib/jellyfin /etc/jellyfin

echo "==> Removing the custom web client override, if present"
rm -f /etc/systemd/system/jellyfin.service.d/webdir.conf

echo "==> Starting jellyfin"
systemctl daemon-reload
systemctl start jellyfin
sleep 8
systemctl is-active jellyfin
dpkg-query -W -f='    now running jellyfin-server ${Version}\n' jellyfin-server

cat <<MSG

Rolled back. Check:  journalctl -u jellyfin -n 100 --no-pager

The 12.0 data is still on disk, nothing was deleted:
    $ASIDE
    $ASIDE.etc
Delete them once you are satisfied the rollback is good:
    sudo rm -rf $ASIDE $ASIDE.etc
MSG
