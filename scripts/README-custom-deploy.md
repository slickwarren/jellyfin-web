# Running this fork on the jelly-amd64 server

The `jellyfin-web` Debian package installs the stock client to `/usr/share/jellyfin/web`, and
`jellyfin.service` starts `/usr/bin/jellyfin $JELLYFIN_WEB_OPT …` with
`JELLYFIN_WEB_OPT="--webdir=/usr/share/jellyfin/web"` sourced from `/etc/default/jellyfin`.
A systemd drop-in points that variable at a locally built copy of this fork -- via a second
`EnvironmentFile=`, **not** `Environment=`. Per `man systemd.exec`, "Settings from these files
override settings made with `Environment=`", so a drop-in using `Environment=` is silently
overridden by `/etc/default/jellyfin` no matter how the drop-ins are ordered. Multiple
`EnvironmentFile=` entries are "read in the order they are specified and the later setting will
override the earlier setting", and drop-ins are parsed after the main unit -- so the drop-in names
a second file, `/etc/default/jellyfin-webdir`, which wins.

Two facts about that box shape everything here:

- **Jellyfin runs as `slickwarren`**, not the `jellyfin` user — set by `User=`/`Group=` in
  `/etc/systemd/system/jellyfin.service.d/jellyfin.service.conf`. So the web root lives in that
  user's home and **no step of a routine deploy needs root**, except restarting the service.
- **`sudo` requires a password**, so the privileged steps are yours to run.

## Layout on the server

```
~/.local/node/                          Node 24 (userland install, no root)
~/src/jellyfin-web/                     git checkout + node_modules (build workspace)
~/bin/deploy-jellyfin-web.sh            the deploy script
~/bin/jellyfin-webdir.conf              the systemd drop-in, to be installed as root
~/bin/jellyfin-webdir.env               the webdir value, installed to /etc/default/jellyfin-webdir
~/bin/check-jellyfin-dirs.sh            permission preflight (run after any jellyfin upgrade)
~/jellyfin-web/releases/<stamp>-<sha>/  one deployed build each, newest 3 kept
~/jellyfin-web/current -> releases/…    the active build; the --webdir target
/usr/share/jellyfin/web                 untouched packaged client (fallback)
```

The scripts live in `~/bin`, deliberately **outside** the checkout: the deploy script runs
`git clean -fd` inside `~/src/jellyfin-web`, which would delete them if they sat there untracked.

## Routine deploy (no root except the restart)

```bash
~/bin/deploy-jellyfin-web.sh
sudo systemctl restart jellyfin      # only if the script reports it could not
```

The script fetches `origin/master`, hard-resets to it, runs `npm ci` and the production build,
refuses to publish a build that fails its sanity checks, installs it as a new release, swaps the
`current` symlink atomically, and prunes to the newest 3 releases (never the active one). It uses
`sudo -n` for the restart, so it reports rather than blocking if a password is needed.

To make weekly runs fully unattended, add a `/etc/sudoers.d/jellyfin-web` rule limited to
`systemctl restart jellyfin`, then a cron entry after the Monday 06:00 UTC fork sync.

## Version matching — the thing that will bite you

The client and server must be the same major version. As of this writing:

- The server was on **stable 10.11.11**; this fork's `master` is **12.0.0**. Those are incompatible.
- The unstable apt channel does not publish `12.0.x` — it publishes **dated nightlies**
  (`2026081705+ubu2404` = 2026-08-17), built from the same `master` line as this fork.
- So a build of this fork's `master` can run a few days ahead of the server nightly. If the client
  misbehaves after a deploy, version skew is the first thing to suspect: either redeploy an older
  release from `~/jellyfin-web/releases`, or `apt upgrade` the server nightly to catch up.

If the server is ever moved back to stable 10.x, rebase the custom commits onto `release-10.11.z`
instead — they cherry-pick onto `v10.11.11` cleanly, but that branch needs **Node 20, npm <11**
(`engine-strict=true`), not the Node 24 that `master` requires.

## Rollback

```bash
ls ~/jellyfin-web/releases
ln -sfn ~/jellyfin-web/releases/<previous> ~/jellyfin-web/current.tmp
mv -Tf ~/jellyfin-web/current.tmp ~/jellyfin-web/current
sudo systemctl restart jellyfin
```

Back to the packaged client entirely:

```bash
sudo rm /etc/systemd/system/jellyfin.service.d/webdir.conf
sudo systemctl daemon-reload && sudo systemctl restart jellyfin
```

The apt `jellyfin-web` package stays installed and untouched throughout, so it is always a working
fallback and needs no `apt-mark hold`.

## Gotchas

- **The service drop-in is a modified dpkg conffile.** `jellyfin.service.conf` sets
  `User=slickwarren` and dpkg knows it has been edited, so package upgrades will offer to replace it.
  Accepting the package version reverts Jellyfin to the `jellyfin` user, which cannot read
  `/var/lib/jellyfin` or `/etc/jellyfin` (both owned by `slickwarren`) — the server then fails to
  start. Always keep the local version (`--force-confold`).
- **Commit your customisations.** The deploy script runs `git reset --hard origin/master`; anything
  not committed and pushed to the fork is destroyed. Client config tweaks (`menuLinks`,
  `multiserver`, …) belong in `src/config.json` on the fork — `dist/config.json` is regenerated on
  every build.
- **Directory ownership after upgrades.** Jellyfin runs as `slickwarren`, but the packages create
  `/var/lib`, `/etc`, `/var/log` and `/var/cache/jellyfin` owned by `jellyfin`, and an upgrade can
  reset them. The 12.0 line writes `CACHEDIR.TAG` into the cache directory on every start and aborts
  with `UnauthorizedAccessException` if it cannot -- a crash loop with no obvious cause. Run
  `bash ~/bin/check-jellyfin-dirs.sh` after any jellyfin package upgrade.
- **You cannot read the effective `--webdir` from the unit.** `systemctl show -p ExecStart` returns
  the literal, unexpanded `$JELLYFIN_WEB_OPT`, so grepping it for `--webdir` finds nothing whether or
  not an override is active. Read the running process's argv instead
  (`tr '\0' '\n' < /proc/$(systemctl show jellyfin -p MainPID --value)/cmdline`), or compare the
  md5 of the served `/web/index.html` against the build on disk. The deploy script does both.
- **Service worker.** Assets are content-hashed and a service worker is registered, so a hard refresh
  (or DevTools → Application → Unregister service worker) may be needed once after a deploy.

## Verifying a deploy

```bash
tr '\0' '\n' < /proc/$(systemctl show jellyfin -p MainPID --value)/cmdline | grep -- --webdir
curl -s http://localhost:8096/web/index.html | md5sum      # must equal the line below
md5sum ~/jellyfin-web/current/index.html                   # the build you just deployed
readlink -f ~/jellyfin-web/current                                   # -> the release just built
systemctl is-active jellyfin && journalctl -u jellyfin -n 50 --no-pager
curl -sI http://localhost:8096/web/index.html | head -1              # -> 200
```

Then in a browser: the audio player exposes the playback-speed control, and the now-playing time
updates on the displayed-second boundary.
