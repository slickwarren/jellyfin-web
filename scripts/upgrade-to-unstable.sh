#!/usr/bin/env bash
#
# Switch this server from the Jellyfin stable channel (10.11.11) to the unstable
# channel (dated master nightlies, the 12.0 dev line) and upgrade.
#
# RUN WITH: sudo bash ~/bin/upgrade-to-unstable.sh
#
# READ FIRST -- what is and is not reversible:
#   * Jellyfin migrates its database on first start of the new version. There is
#     no supported downgrade. Rolling back means restoring the backup this
#     script takes -- see ~/bin/rollback-to-stable.sh, which is written to do
#     exactly that, using the manifest and backup produced here.
#   * Anything you watch/change AFTER the upgrade is lost by a rollback, because
#     the rollback restores the pre-upgrade database. The longer you wait to
#     roll back, the more you lose.
#   * The unstable channel is NOT versioned 12.0.x -- it publishes dated
#     nightlies. Newest available at time of writing: 2026081705 (2026-08-17).
#   * jellyfin-ffmpeg8 Conflicts/Replaces jellyfin-ffmpeg6 and jellyfin-ffmpeg7,
#     so BOTH of your current ffmpeg packages get REMOVED and replaced. The
#     rollback script reinstalls jellyfin-ffmpeg7.
#
# This script does NOT activate the custom web client. That is a separate step,
# once you have confirmed the 12.0 server is healthy.

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }

BACKUP_DIR="/home/slickwarren/jellyfin-backups"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_DIR/jellyfin-pre-12.0-$STAMP.tar.gz"
MANIFEST="$BACKUP_DIR/jellyfin-pre-12.0-$STAMP.manifest"
SOURCES="/etc/apt/sources.list.d/jellyfin.sources"
STOPPED=0

# If anything fails after we stop Jellyfin, bring it back up on the version it
# is currently installed at rather than leaving the media server down.
on_exit() {
    local rc=$?
    # Never let a failure inside the recovery path abort the recovery itself.
    # With `set -e` still active, one bad command here (as happened once) exits
    # the shell before the service gets restarted.
    set +e
    if [ "$rc" -ne 0 ] && [ "$STOPPED" -eq 1 ]; then
        echo
        echo "ERROR: failed (exit $rc). Restarting jellyfin on whatever is installed now." >&2
        systemctl start jellyfin || true
        systemctl is-active jellyfin || true
        echo "       Backup (if it got that far): $BACKUP" >&2
        echo "       Package state before this run: $MANIFEST" >&2
    fi
}
trap on_exit EXIT

echo "==> Current versions:"
dpkg-query -W -f='    ${Package} ${Version}\n' jellyfin jellyfin-server jellyfin-web jellyfin-ffmpeg6 jellyfin-ffmpeg7 2>/dev/null || true

mkdir -p "$BACKUP_DIR"
echo "==> Recording package manifest to $MANIFEST"
dpkg-query -W -f='${Package}=${Version}\n' 'jellyfin*' > "$MANIFEST"
cp -a "$SOURCES" "$BACKUP_DIR/jellyfin.sources.bak-$STAMP"

read -r -p "Proceed with backup + upgrade to the unstable channel? [y/N] " reply
[ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "Aborted."; exit 1; }

echo "==> Stopping jellyfin for a consistent database copy"
# Set this BEFORE stopping, so the EXIT trap restarts the service no matter
# where a failure happens from here on.
STOPPED=1
# This server takes longer to shut down than the unit's TimeoutStopSec=15, so
# systemd SIGKILLs it and the unit lands in "failed". That is not an error for
# our purposes -- SQLite is crash-safe and the backup includes the -wal/-shm
# files -- but it does make `systemctl stop` return non-zero, which would
# otherwise abort the script under `set -e`.
systemctl stop jellyfin || true
for _ in $(seq 1 30); do
    systemctl is-active --quiet jellyfin || break
    sleep 1
done
if systemctl is-active --quiet jellyfin; then
    echo "ERROR: jellyfin is still running after 30s; not touching the database." >&2
    exit 1
fi
systemctl reset-failed jellyfin 2>/dev/null || true
echo "    stopped"

echo "==> Backing up config + database to $BACKUP"
echo "    (excluding subtitles/trickplay/attachments -- 39G of regenerable cache)"
tar -czf "$BACKUP" \
    --exclude='var/lib/jellyfin/data/subtitles' \
    --exclude='var/lib/jellyfin/data/trickplay' \
    --exclude='var/lib/jellyfin/data/attachments' \
    -C / etc/jellyfin var/lib/jellyfin
chown slickwarren:slickwarren "$BACKUP" "$MANIFEST"
echo "    backup size: $(du -h "$BACKUP" | cut -f1)"

echo "==> Verifying the backup is readable and contains the database"
gzip -t "$BACKUP"
tar -tzf "$BACKUP" var/lib/jellyfin/data/jellyfin.db >/dev/null
echo "    backup verified"

echo "==> Adding the unstable component to $SOURCES"
sed -i 's/^Components: main$/Components: main unstable/' "$SOURCES"
grep '^Components:' "$SOURCES"

echo "==> apt update"
apt-get update -qq

echo
echo "==> This is what apt proposes to do (note the REMOVED line):"
apt-get -s install jellyfin jellyfin-server jellyfin-web \
    | grep -E '^(Inst|Remv|The following)' | head -30
echo
read -r -p "Apply this? [y/N] " reply2
if [ "$reply2" != "y" ] && [ "$reply2" != "Y" ]; then
    echo "Aborted -- reverting the apt source and restarting jellyfin."
    cp -a "$BACKUP_DIR/jellyfin.sources.bak-$STAMP" "$SOURCES"
    apt-get update -qq
    systemctl start jellyfin
    STOPPED=0
    exit 1
fi

echo "==> Upgrading jellyfin packages"
# --force-confold is deliberate and important: your
# /etc/systemd/system/jellyfin.service.d/jellyfin.service.conf is a dpkg
# conffile that you have modified (it sets User/Group = slickwarren). Accepting
# the package's version would revert Jellyfin to the "jellyfin" user, which
# cannot read /var/lib/jellyfin or /etc/jellyfin (both owned by slickwarren) --
# the server would then fail to start. confold keeps your version.
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    -o Dpkg::Options::=--force-confold \
    -o Dpkg::Options::=--force-confdef \
    jellyfin jellyfin-server jellyfin-web

echo "==> Verifying your User=/Group= override survived"
grep -E '^\s*(User|Group)\s*=' /etc/systemd/system/jellyfin.service.d/jellyfin.service.conf \
    || { echo "ERROR: User=/Group= override is gone. Restore it before starting." >&2; exit 1; }

echo "==> Verifying ffmpeg is still wired up"
ls -l /usr/lib/jellyfin-ffmpeg/ffmpeg

# A package upgrade can reset ownership of the service directories back to the
# `jellyfin` user, which breaks a server configured to run as someone else. The
# 12.0 line writes CACHEDIR.TAG into the cache dir on every start and aborts if
# it cannot, so catch this BEFORE starting rather than after a crash loop.
echo "==> Checking the service user can write all of its directories"
if ! bash "$(dirname "${BASH_SOURCE[0]}")/check-jellyfin-dirs.sh"; then
    echo
    echo "ERROR: fix the ownership above, then run: sudo systemctl start jellyfin" >&2
    exit 1
fi

echo "==> Starting jellyfin"
systemctl daemon-reload
systemctl start jellyfin
STOPPED=0
sleep 8
systemctl is-active jellyfin
dpkg-query -W -f='    now running jellyfin-server ${Version}\n' jellyfin-server

cat <<MSG

Done. Next:
  1. Watch the migration actually finish before trusting it:
       journalctl -u jellyfin -f
     and load the web UI on the stock nightly client.
  2. Only then activate the custom build:
       sudo install -Dm644 /home/slickwarren/bin/jellyfin-webdir.conf \\
         /etc/systemd/system/jellyfin.service.d/webdir.conf
       sudo systemctl daemon-reload && sudo systemctl restart jellyfin

If it went wrong:
       sudo bash /home/slickwarren/bin/rollback-to-stable.sh $STAMP

Backup:   $BACKUP
Manifest: $MANIFEST
MSG
