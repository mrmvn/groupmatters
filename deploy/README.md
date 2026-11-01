# Deploying to a Debian VPS (systemd + Caddy)

Generic files only: no hostnames or users live in the repo. Put them in `~/.ssh/config`
(`Host groupmatters` …) and a git-ignored `.deploy.env` (see `deploy.env.example`).

## One-time server setup (as root or with sudo)

```sh
# 0. Basics: firewall (22, 80, 443 only), SSH keys only, unattended-upgrades
apt install -y ufw sqlite3 rsync curl git caddy   # Caddy not in your Debian? see caddyserver.com/docs/install#debian-ubuntu-raspbian
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable   # check `ufw show added` lists SSH before enable

# 1. Node >= 24 (NodeSource or the official tarball in /usr/local); check: node -v
# 2. Service user and code directory (owned by your deploy user, read by the service)
useradd --system --home /var/lib/groupmatters --shell /usr/sbin/nologin groupmatters
mkdir -p /opt/groupmatters && chown "$DEPLOY_USER": /opt/groupmatters

# 3. Config (secrets stay out of the code directory)
# (group-readable so the service user can run the CLI with --env-file)
install -m 640 -o root -g groupmatters /dev/null /etc/groupmatters.env
tee -a /etc/groupmatters.env >/dev/null <<'ENV'
PUBLIC_URL=https://groupmatters.org
SOURCE_URL=https://github.com/mrmvn/groupmatters
CONTACT_EMAIL=
HOSTING=
# GITHUB_TOKEN=
ENV

# 4. Allow the deploy user to restart the service without a password
echo '<deploy-user> ALL=(root) NOPASSWD: /usr/bin/systemctl restart groupmatters' > /etc/sudoers.d/groupmatters
chmod 440 /etc/sudoers.d/groupmatters && visudo -c
```

Run the block as root (`sudo -i`); `useradd`, `ufw` etc. live in `/usr/sbin`, which isn't on a normal user's `PATH`.

Then fetch the code (the repo is public, so a plain https clone works) and install the service files:

```sh
git clone https://github.com/mrmvn/groupmatters.git /opt/groupmatters   # directory must be empty
sudo cp /opt/groupmatters/deploy/groupmatters.service /opt/groupmatters/deploy/groupmatters-backup.service \
        /opt/groupmatters/deploy/groupmatters-backup.timer /etc/systemd/system/
sudo cp /opt/groupmatters/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now groupmatters groupmatters-backup.timer
sudo systemctl reload caddy
sudo -u groupmatters env DB_PATH=/var/lib/groupmatters/register.sqlite node --env-file=/etc/groupmatters.env /opt/groupmatters/src/cli.ts create-space "Our group"
```

DNS: `A`/`AAAA` for `groupmatters.org` and `www` in Namecheap, before reloading Caddy (it needs them to get certificates).

## Updates

Commit and push, then `./deploy/deploy.sh` (locally). It refuses to run with uncommitted or unpushed changes, runs typecheck + tests,
then `git pull --ff-only` on the server, restarts the service and checks `/healthz`.
`SKIP_TESTS=1 ./deploy/deploy.sh` for an urgent tweak. Changes to the unit or Caddy files also need re-copying (step above) and a reload.
Schema migrations snapshot the DB first (`register.sqlite.before-vN.bak` in `/var/lib/groupmatters`).

## Backups

The timer runs `backup.sh` daily (14 generations in `/var/lib/groupmatters/backups`, integrity-checked).
`./deploy/pull-backups.sh` copies them to your machine. **Test a restore once**:
```sh
sudo systemctl stop groupmatters
sudo -u groupmatters cp /var/lib/groupmatters/backups/register-YYYY-MM-DD.sqlite /var/lib/groupmatters/register.sqlite
sudo rm -f /var/lib/groupmatters/register.sqlite-wal /var/lib/groupmatters/register.sqlite-shm
sudo systemctl start groupmatters
```

Check: `systemctl list-timers groupmatters-backup.timer`, `journalctl -u groupmatters -f`.
