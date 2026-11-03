#!/usr/bin/env bash
# Installs the Claude Hub worker on a Linux VPS as a separate, unprivileged "claude" user.
# Run as root after copying this repo to /opt/claude-hub. Safe to re-run.
#
# - adds 2 GB swap if there is none, so Claude and builds can't push live apps out of memory
# - creates user "claude" (no sudo, private home); it works only in its own clones
# - runs the hub as a low-priority systemd service with a memory cap
# Secrets live in /etc/claude-hub.env (root-only); fill it with setup/set-vps-secrets.ps1.
set -euo pipefail

HUB_DIR=/opt/claude-hub
HUB_USER=claude
HOME_DIR=/home/$HUB_USER

if ! swapon --show --noheadings | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "added 2G swap"
fi

id -u "$HUB_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$HUB_USER"
chmod 700 "$HOME_DIR"
chown -R root:root "$HUB_DIR"
chmod -R go-w "$HUB_DIR"

if [ ! -f "$HOME_DIR/hub.config.json" ]; then
  cat > "$HOME_DIR/hub.config.json" <<EOF
{
  "machine": "vps",
  "workDir": "$HOME_DIR/.claude-hub/work",
  "claimDelaySeconds": 0,
  "deploy": {}
}
EOF
  chown "$HUB_USER:$HUB_USER" "$HOME_DIR/hub.config.json"
fi

[ -f /etc/claude-hub.env ] || install -m 600 /dev/null /etc/claude-hub.env

# Deploys: the hub may run exactly one root command, the deploy script. What each project deploys
# is set in /etc/claude-hub/deploy.d/<repo>.conf, which only root can edit.
install -m 755 -o root -g root "$HUB_DIR/setup/hub-deploy.sh" /usr/local/sbin/hub-deploy
install -d -m 700 /etc/claude-hub/deploy.d
echo "$HUB_USER ALL=(root) NOPASSWD: /usr/local/sbin/hub-deploy" > /etc/sudoers.d/claude-hub
chmod 440 /etc/sudoers.d/claude-hub
visudo -cf /etc/sudoers.d/claude-hub >/dev/null

cat > /etc/systemd/system/claude-hub.service <<EOF
[Unit]
Description=Claude Hub worker (runs instructions sent from the phone app)
After=network-online.target
Wants=network-online.target

[Service]
User=$HUB_USER
WorkingDirectory=$HOME_DIR
EnvironmentFile=/etc/claude-hub.env
Environment=HUB_CONFIG=$HOME_DIR/hub.config.json
Environment=DISABLE_AUTOUPDATER=1
ExecStart=$(command -v node) $HUB_DIR/hub/hub.mjs
Restart=always
RestartSec=30
Nice=10
CPUWeight=50
IOWeight=50
MemoryHigh=1500M
MemoryMax=2G

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable claude-hub >/dev/null
if grep -q GITHUB_TOKEN /etc/claude-hub.env; then
  systemctl restart claude-hub
  echo "claude-hub restarted"
else
  echo "installed; add secrets with setup/set-vps-secrets.ps1, then it starts automatically"
fi
