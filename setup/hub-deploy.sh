#!/usr/bin/env bash
# Deploys a Claude Hub project from the hub's clone to where it runs live. Runs as root.
# The hub (user "claude") calls it after a successful push:  sudo /usr/local/sbin/hub-deploy <repo>
#
# Every deploy: backs up databases, snapshots the code it replaces, copies the new code in
# (never deleting anything, never touching .env / databases / data), rebuilds only the services that
# are already running, then checks the site still answers. If it doesn't, the old code is put back.
#
# Per-project settings: /etc/claude-hub/deploy.d/<repo>.conf (root-only, bash). Example:
#   DEST=/opt/myapp                 # live folder
#   SRC_DIR=server                  # subfolder of the repo to deploy (default: repo root)
#   PATHS=(app Dockerfile docker-compose.yml)
#   COMPOSE_FILE=docker-compose.yml # or RESTART="docker restart myapp"
#   HEALTH=(http://127.0.0.1:8000/ "https://site.example.com/")
#   BACKUP=('docker exec db pg_dumpall -U app | gzip > db.sql.gz')   # run inside the backup folder
#   CUSTOM='bash /opt/myapp/deploy.sh'  ROLLBACK='...'               # use an existing deploy script
# Exit codes: 0 live, 1 failed (rolled back if possible), 3 nothing configured for this project.
set -euo pipefail

P=${1:-}
[[ "$P" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad project name"; exit 2; }
CONF=/etc/claude-hub/deploy.d/$P.conf
[ -f "$CONF" ] || { echo "no deploy configured for $P"; exit 3; }

WORK=/home/claude/.claude-hub/work/$P
SRC_DIR=.
DEST=
PATHS=()
COMPOSE_FILE=docker-compose.yml
RESTART=
CUSTOM=
ROLLBACK=
HEALTH=()
BACKUP=()
EXCLUDES=(.git/ .env '.env.*' '*.db' '*.db-*' '*.sqlite*' 'data/' 'backups/' 'backups-manual/' '__pycache__/' 'node_modules/' '*.bak*' '.ruff_cache/')
# shellcheck source=/dev/null
source "$CONF"

TS=$(date +%Y%m%d-%H%M%S)
BK=/root/hub-backups/$P/$TS
mkdir -p "$BK"
chmod 700 /root/hub-backups

restart() {
  if [ -n "$RESTART" ]; then eval "$RESTART"; return; fi
  cd "$DEST"
  mapfile -t running < <(docker compose -f "$COMPOSE_FILE" ps --services --status running)
  [ ${#running[@]} -gt 0 ] || { echo "no running services in $DEST"; return 1; }
  docker compose -f "$COMPOSE_FILE" up -d --build "${running[@]}" 2>&1 | tail -15
}

code_of() { curl -k -s -o /dev/null -m 15 -w '%{http_code}' "$1" || true; }
healthy() {
  local url c
  for url in "${HEALTH[@]}"; do
    c=$(code_of "$url")
    if [ "$c" = "000" ] || [ "${c:0:1}" = "5" ]; then echo "  $url -> $c"; return 1; fi
  done
}
wait_healthy() {
  for _ in $(seq 1 24); do healthy >/dev/null && return 0; sleep 5; done
  healthy
}

echo "== backup -> $BK"
if [ -n "$DEST" ]; then
  find "$DEST" -maxdepth 4 -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) \
    -not -path '*/backups*' -not -name '*.bak*' -print0 | while IFS= read -r -d '' f; do
      mkdir -p "$BK/data$(dirname "$f")"
      # online backup API: consistent even while the app is writing
      python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' \
        "$f" "$BK/data$f" 2>/dev/null || cp -p "$f" "$BK/data$f"
    done
fi
for cmd in "${BACKUP[@]}"; do (cd "$BK" && eval "$cmd"); done
if [ -z "$CUSTOM" ]; then
  existing=()
  for p in "${PATHS[@]}"; do [ -e "$DEST/$p" ] && existing+=("$p"); done
  [ ${#existing[@]} -eq 0 ] || tar -C "$DEST" -czf "$BK/code.tgz" "${existing[@]}"
fi
du -sh "$BK" | cut -f1 | sed 's/^/  backup size: /'
# keep the last 10 backups per project
ls -1dt /root/hub-backups/"$P"/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf

echo "== deploy"
if [ -n "$CUSTOM" ]; then
  eval "$CUSTOM"
else
  ex=(); for e in "${EXCLUDES[@]}"; do ex+=(--exclude "$e"); done
  for p in "${PATHS[@]}"; do
    src="$WORK/$SRC_DIR/$p"
    [ -e "$src" ] || { echo "  skip missing $p"; continue; }
    if [ -d "$src" ]; then mkdir -p "$DEST/$p"; rsync -rt --checksum --itemize-changes "${ex[@]}" "$src/" "$DEST/$p/" | grep -c '^>' | sed "s|^|  $p: |;s|$| file(s) updated|"
    else rsync -t --checksum "$src" "$DEST/$p"; echo "  $p"; fi
  done
  restart
fi

echo "== health check"
if wait_healthy; then
  echo "live ✓"
  exit 0
fi

echo "!! not healthy, rolling back"
if [ -n "$CUSTOM" ]; then
  [ -n "$ROLLBACK" ] && eval "$ROLLBACK"
elif [ -f "$BK/code.tgz" ]; then
  tar -C "$DEST" -xzf "$BK/code.tgz"
  restart
fi
wait_healthy && echo "rolled back, previous version is live again" || echo "!! still unhealthy after rollback, check the server"
exit 1
