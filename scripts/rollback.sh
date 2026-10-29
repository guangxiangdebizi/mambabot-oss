#!/bin/bash
# Restores the code directory and nginx file saved by deploy.sh, then restarts the site.
#   bash scripts/rollback.sh <backups>/deploy-<timestamp> [--with-data]
# --with-data also restores conversations/sessions from that backup.
set -euo pipefail
STATE=${1:?usage: rollback.sh <backup dir> [--with-data]}
SITE_ENV=${AW_SITE_ENV:-$HOME/.config/assistant-web/site.env}
# shellcheck disable=SC1090
[ -f "$SITE_ENV" ] && . "$SITE_ENV"
: "${LIVE_DIR:?set LIVE_DIR in $SITE_ENV}"
DATA=${AW_DATA_DIR:-$HOME/.local/share/assistant-web}
NGINX_CONF=${NGINX_CONF:-}
PREV=$(cat "$STATE/prev-dir")
[ -d "$PREV" ] || { echo "找不到之前的代码目录 $PREV" >&2; exit 1; }

if tmux has-session -t assistant-web 2>/dev/null; then
  tmux send-keys -t assistant-web C-c
  for _ in $(seq 1 20); do tmux has-session -t assistant-web 2>/dev/null || break; sleep 1; done
  tmux kill-session -t assistant-web 2>/dev/null || true
fi
TS=$(date +%Y%m%dT%H%M%S)
[ -d "$LIVE_DIR" ] && mv "$LIVE_DIR" "$LIVE_DIR.failed-$TS"
mv "$PREV" "$LIVE_DIR"
if [ -n "$NGINX_CONF" ] && [ -f "$STATE/nginx.conf" ]; then
  sudo -n install -m 644 "$STATE/nginx.conf" "$NGINX_CONF"
  sudo -n nginx -t && sudo -n systemctl reload nginx
fi
if [ "${2:-}" = "--with-data" ]; then
  mv "$DATA" "$DATA.v2-$TS"
  tar xzf "$STATE/data.tgz" -C "$(dirname "$DATA")"
fi
tmux new-session -d -s assistant-web -c "$LIVE_DIR" scripts/serve.sh
sleep 3
curl -fsS "http://127.0.0.1:${AW_PORT:-3400}/healthz" && echo " 已回滚到之前的版本"
