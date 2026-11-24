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
~/bin/auto-deploy-jellyfin-web.sh       the weekly wrapper run by jellyfin-web-deploy.timer
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

## Weekly unattended deploy

`jellyfin-web-deploy.timer` runs `jellyfin-web-deploy.service` on Mondays at 09:30, 10:30 and
11:30 server time (America/Los_Angeles), when nobody is using the server. The fork sync is
scheduled for Monday 06:00 UTC, but GitHub starts scheduled workflows hours late (04:40–08:56
Pacific so far), so an early-morning run would always ship the previous week's sync.

The service runs `~/bin/auto-deploy-jellyfin-web.sh` as `slickwarren`. The wrapper fetches the
fork and:

- stops if `origin/master` is already the deployed release, so the later runs and Jellyfin's
  restart happen at most once a week;
- skips the week, and logs why, if the fork's major version no longer matches the server's
  (see "Version matching" below);
- otherwise runs `~/bin/deploy-jellyfin-web.sh`.

The production build peaks at about 6 GB across 19 processes (measured 2026-11-23). On
2026-10-30 a deploy ran the 15 GB box out of memory and the kernel killed qBittorrent, so the
service caps the build (`MemoryHigh=7G`, `MemoryMax=8G`) and sets `OOMScoreAdjust=1000`, making
the build the first thing killed if memory still runs out. A killed build just leaves the current
release in place.

The restart needs `/etc/sudoers.d/jellyfin-web`, which allows exactly
`systemctl restart jellyfin.service` without a password, and nothing else.

Install, from the checkout:

```bash
install -m 755 scripts/auto-deploy-jellyfin-web.sh scripts/deploy-jellyfin-web.sh ~/bin/
sudo visudo -cf scripts/jellyfin-web.sudoers && sudo install -m 440 -o root -g root scripts/jellyfin-web.sudoers /etc/sudoers.d/jellyfin-web
sudo install -m 644 scripts/jellyfin-web-deploy.service scripts/jellyfin-web-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now jellyfin-web-deploy.timer
```

Then:

```bash
systemctl list-timers jellyfin-web-deploy.timer      # next run
sudo systemctl start jellyfin-web-deploy.service     # deploy now (restarts Jellyfin)
cat /var/log/jellyfin-web-deploy.log                 # what each run did
sudo systemctl disable --now jellyfin-web-deploy.timer   # stop the weekly runs
```

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
- **Service worker.** Upstream removed the service worker in November 2026 ("Remove non-functional
  service worker"), so builds no longer contain `serviceworker.js` and the app unregisters any old
  one on load. Assets are content-hashed, so a hard refresh may still be needed once after a deploy.

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
