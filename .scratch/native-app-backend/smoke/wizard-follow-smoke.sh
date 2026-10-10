#!/usr/bin/env bash
# 旧 Swift follow 向导已退役；保留入口提示，避免沿用旧数据与权限路径。

printf '%s\n' \
  '此 follow 向导已退役，不再启动探针、后端或微信 CLI。' \
  '请查看 .scratch/native-app-backend/follow-smoke-runbook-20261005.md。' \
  '真实验收需可信 CLI/WCDB、已确认测试联系人和新的有限时段。' >&2
exit 2
