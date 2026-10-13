#!/usr/bin/env bash
# 将 website/ 静态文件同步到服务器并由 nginx 提供访问。
#
# 用法：
#   scripts/deploy_website.sh              同步一次
#   scripts/deploy_website.sh watch        监听本地改动并自动同步（需要 fswatch）
#
# 服务器必须显式配置，远端目录可用环境变量覆盖：
#   NOTALONE_WEB_HOST（必填，例如 user@example.invalid）
#   NOTALONE_WEB_PATH（默认 /var/www/notalone）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/website"
HOST="${NOTALONE_WEB_HOST:-}"
DEST="${NOTALONE_WEB_PATH:-/var/www/notalone}"

if [[ -z "$HOST" ]]; then
  echo "请先设置 NOTALONE_WEB_HOST 为已授权的 SSH 部署目标，例如 user@example.invalid。" >&2
  exit 2
fi

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
RSYNC_OPTS=(-az --delete --exclude '.DS_Store' --exclude 'README.md')

sync_once() {
  echo "同步 $SRC -> $HOST:$DEST"
  ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$DEST'"
  rsync "${RSYNC_OPTS[@]}" -e "ssh ${SSH_OPTS[*]}" "$SRC/" "$HOST:$DEST/"
  echo "完成：http://${HOST#*@}/"
}

case "${1:-deploy}" in
  deploy)
    sync_once
    ;;
  watch)
    if ! command -v fswatch >/dev/null 2>&1; then
      echo "缺少 fswatch，请先执行：brew install fswatch" >&2
      exit 1
    fi
    sync_once
    echo "监听改动中（Ctrl-C 退出）"
    fswatch -o -l 0.5 "$SRC" | while read -r _; do
      sync_once || echo "同步失败，等待下次改动重试" >&2
    done
    ;;
  *)
    echo "用法：$0 [deploy|watch]" >&2
    exit 2
    ;;
esac
