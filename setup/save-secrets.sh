#!/usr/bin/env bash
# Runs on the VPS (as root). Reads KEY=value lines on stdin and merges them into /etc/claude-hub.env,
# keeping any keys not given, then restarts the hub. Called by set-vps-secrets.ps1.
set -euo pipefail
umask 077
f=/etc/claude-hub.env
touch "$f"
tr -d '\r' | while IFS= read -r line; do
  [ -n "$line" ] || continue
  k=${line%%=*}
  grep -v "^$k=" "$f" > "$f.tmp" || true
  printf '%s\n' "$line" >> "$f.tmp"
  mv "$f.tmp" "$f"
done
systemctl restart claude-hub
sleep 6
systemctl is-active claude-hub
journalctl -u claude-hub -n 4 --no-pager -o cat
