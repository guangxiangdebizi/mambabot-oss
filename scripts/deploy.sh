#!/bin/bash
# Controlled switch of the live site to a committed version of this repository, with
# automatic rollback if the new server does not come up healthy.
#
#   bash scripts/deploy.sh [commit]      (as the service user; default: HEAD of this checkout)
#
# Host settings come from $AW_SITE_ENV (default ~/.config/assistant-web/site.env):
#   LIVE_DIR (required)   directory the live tmux session runs from
#   BACKUPS               where backups go (default ~/backups)
#   NGINX_CONF/NGINX_SITE installed nginx file / its private source (optional, needs sudo -n)
#   PUBLIC_URL            public address checked after the switch (optional)
#
# What it does, in order:
#   1. refuses to run while the live site has a reply in progress, or when tests fail
#   2. backs up live data (conversations, sessions, prefs) and the current code directory
#   3. stops the preview server and the browser it owns (the live server starts its own)
#   4. installs NGINX_SITE as NGINX_CONF when both are set (nginx -t first; restored on failure)
#   5. exports the commit into a fresh directory and swaps it in as LIVE_DIR
#   6. restarts the `assistant-web` tmux session gracefully and checks /healthz
# Rollback: scripts/rollback.sh (restores the previous code directory and nginx file).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
COMMIT=${1:-HEAD}
SITE_ENV=${AW_SITE_ENV:-$HOME/.config/assistant-web/site.env}
# shellcheck disable=SC1090
[ -f "$SITE_ENV" ] && . "$SITE_ENV"
: "${LIVE_DIR:?set LIVE_DIR in $SITE_ENV}"
DATA=${AW_DATA_DIR:-$HOME/.local/share/assistant-web}
BACKUPS=${BACKUPS:-$HOME/backups}
NGINX_CONF=${NGINX_CONF:-}
NGINX_SITE=${NGINX_SITE:-}
PUBLIC_URL=${PUBLIC_URL:-}
PORT=${AW_PORT:-3400}
TS=$(date +%Y%m%dT%H%M%S)
STATE=$BACKUPS/deploy-$TS
NODE=${NODE:-$(command -v node)}

say() { printf '\n== %s\n' "$*"; }

say "预检"
SHA=$(git -C "$REPO" rev-parse --verify "$COMMIT^{commit}")
echo "版本 $SHA"
if grep -lq '"status":"\(running\|stopping\)"' "$DATA"/conversations/*.json 2>/dev/null; then
  echo "线上有正在进行的回复，先等它结束或停止后再部署。" >&2
  exit 1
fi
(cd "$REPO" && "$NODE" --test --test-timeout=20000 test/*.test.js >/dev/null) || { echo "测试未通过，停止部署。" >&2; exit 1; }
if [ -n "$NGINX_CONF" ] && [ -n "$NGINX_SITE" ]; then
  sudo -n true || { echo "需要 sudo -n（安装 nginx 配置）。" >&2; exit 1; }
fi

say "备份"
mkdir -p "$STATE" && chmod 700 "$STATE"
tar czf "$STATE/data.tgz" -C "$(dirname "$DATA")" "$(basename "$DATA")"
[ -n "$NGINX_CONF" ] && sudo -n cat "$NGINX_CONF" > "$STATE/nginx.conf"
echo "$LIVE_DIR.prev-$TS" > "$STATE/prev-dir"
echo "$SHA" > "$STATE/commit"
echo "备份目录 $STATE"

say "停止预览服务和它的浏览器"
if tmux has-session -t assistant-web-preview 2>/dev/null; then
  tmux send-keys -t assistant-web-preview C-c
  for _ in $(seq 1 15); do tmux has-session -t assistant-web-preview 2>/dev/null || break; sleep 1; done
  tmux kill-session -t assistant-web-preview 2>/dev/null || true
fi
PIDS=$DATA-preview/browser/pids.json
if [ -f "$PIDS" ]; then
  for pid in $("$NODE" -e 'const p=require(process.argv[1]); console.log([p.browser,p.xvfb].filter(Boolean).join(" "))' "$PIDS"); do
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 3
  pkill -u "$(id -u)" -x browseros-claw- 2>/dev/null || true
  rm -f "$PIDS"
fi

if [ -n "$NGINX_CONF" ] && [ -n "$NGINX_SITE" ]; then
  say "安装 nginx 配置"
  sudo -n install -m 644 "$NGINX_SITE" "$NGINX_CONF"
  if ! sudo -n nginx -t 2>/dev/null; then
    sudo -n install -m 644 "$STATE/nginx.conf" "$NGINX_CONF"
    echo "nginx 配置检查失败，已恢复原配置。" >&2
    exit 1
  fi
  sudo -n systemctl reload nginx
fi

say "切换代码目录"
NEW="$LIVE_DIR.new-$TS"
mkdir -p "$NEW"
git -C "$REPO" archive "$SHA" | tar -x -C "$NEW"
echo "$SHA" > "$NEW/DEPLOYED_COMMIT"
mv "$LIVE_DIR" "$LIVE_DIR.prev-$TS"
mv "$NEW" "$LIVE_DIR"

say "重启线上服务"
if tmux has-session -t assistant-web 2>/dev/null; then
  tmux send-keys -t assistant-web C-c
  for _ in $(seq 1 20); do tmux has-session -t assistant-web 2>/dev/null || break; sleep 1; done
  tmux kill-session -t assistant-web 2>/dev/null || true
fi
tmux new-session -d -s assistant-web -c "$LIVE_DIR" scripts/serve.sh
ok=0
for _ in $(seq 1 20); do
  sleep 1
  if curl -fsS -m 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 \
    && { [ -z "$PUBLIC_URL" ] || curl -fsS -m 5 -o /dev/null "$PUBLIC_URL/app.js"; }; then ok=1; break; fi
done
if [ "$ok" != 1 ]; then
  echo "新版本没有通过健康检查，正在回滚…" >&2
  bash "$REPO/scripts/rollback.sh" "$STATE"
  exit 1
fi
say "完成：线上已运行 $SHA"
echo "回滚：bash $REPO/scripts/rollback.sh $STATE"
