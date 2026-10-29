#!/bin/sh
# Foreground runner, meant for a tmux session (or a systemd unit) as the service user:
#   tmux new-session -d -s assistant-web -c <this checkout> scripts/serve.sh
# Restarts after a crash; a clean exit (SIGTERM/SIGINT -> graceful shutdown, exit 0) ends the loop.
# The server runs with a minimal explicit environment, not the caller's. Host settings come
# from $AW_SITE_ENV (default ~/.config/assistant-web/site.env, see deploy/site.env.example).
# AW_PREVIEW=1 runs a preview copy on port 3401 with its own data directory.
set -u
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
SITE_ENV=${AW_SITE_ENV:-$HOME/.config/assistant-web/site.env}
PREVIEW=${AW_PREVIEW:-0}
# shellcheck disable=SC1090
[ -f "$SITE_ENV" ] && . "$SITE_ENV"
NODE=${NODE:-$(command -v node)}
DATA=${AW_DATA_DIR:-$HOME/.local/share/assistant-web}
PORT=${AW_PORT:-3400}
if [ "$PREVIEW" = 1 ]; then
  DATA=$DATA-preview
  PORT=3401
fi
LOG=$DATA/logs/server.log
mkdir -p "$DATA/logs"
cd "$APP_DIR" || exit 1
echo "MambaBot: logs -> $LOG"
while :; do
  env -i HOME="$HOME" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/bash \
    PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    LANG=C.UTF-8 NODE_ENV=production TZ="${TZ:-UTC}" \
    AW_HOST="${AW_HOST:-127.0.0.1}" AW_PORT="$PORT" AW_DATA_DIR="$DATA" \
    AW_CONFIG_DIR="${AW_CONFIG_DIR:-$HOME/.config/assistant-web}" AW_CLAUDE_CWD="${AW_CLAUDE_CWD:-$HOME/assistant-home}" \
    AW_ALLOWED_HOSTS="${AW_ALLOWED_HOSTS:-}" AW_TRUST_PROXY="${AW_TRUST_PROXY:-0}" AW_COOKIE_SECURE="${AW_COOKIE_SECURE:-0}" \
    AW_BROWSER_BIN="${AW_BROWSER_BIN:-}" AW_BROWSER_PROFILE="${AW_BROWSER_PROFILE:-}" AW_BROWSER="${AW_BROWSER:-1}" \
    "$NODE" src/server.js >>"$LOG" 2>&1
  code=$?
  echo "$(date -Is) server exited with code $code" | tee -a "$LOG"
  [ "$code" -eq 0 ] && break
  sleep 3
done
