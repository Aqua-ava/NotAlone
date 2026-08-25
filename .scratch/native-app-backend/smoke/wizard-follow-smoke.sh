#!/usr/bin/env bash
#
# 真实微信 tail --follow 人工只读冒烟向导。
# 只记录阶段、计数、水位和错误码；不记录聊天正文，不发送外部消息。

set -euo pipefail

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

TOTAL_STAGES=8
STAGE_INDEX=0

_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  你执行微信人工操作；向导只记录元数据并在每一步等待确认。\n' "$DIM"
  printf '  可随时用 Ctrl-C 停止；不会修改业务代码、绑定或同步开关。%s\n' "$RESET"
  pause "准备开始？"
}

stage() {
  _clear
  STAGE_INDEX=$((STAGE_INDEX + 1))
  printf '\n%s%s▸ 阶段 %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

pause() {
  local prompt="按 Enter 继续"
  if [[ $# -gt 0 ]]; then prompt="$1"; fi
  printf '  %s%s%s ' "$DIM" "$prompt" "$RESET"
  read -r _ || true
}

confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

if [[ ! -f pyproject.toml || ! -d src/notalone ]]; then
  printf '%s\n' "请在 NotAlone 仓库根目录运行本脚本。" >&2
  exit 2
fi

LOG_DIR=".scratch/native-app-backend/smoke"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/follow-$RUN_ID.log"
RUNNER_LOG="$LOG_DIR/follow-runner-$RUN_ID.log"
ANSWER_FILE="$LOG_DIR/follow-answer-$RUN_ID.md"
PROBE_BIN="$PWD/macos_sync_probe/build/cli/notalone-sync-probe"
CLI_BIN="wechat-cli"
if [[ -n "$(printenv NOTALONE_SYNC_PROBE 2>/dev/null || true)" ]]; then
  PROBE_BIN="$(printenv NOTALONE_SYNC_PROBE)"
fi
if [[ -n "$(printenv NOTALONE_WECHAT_CLI 2>/dev/null || true)" ]]; then
  CLI_BIN="$(printenv NOTALONE_WECHAT_CLI)"
fi
PYTHON_BIN=""
RUNNER_PID=""
mkdir -p "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(date +%H:%M:%S)" "$1" | tee -a "$LOG_FILE"
}

env_file_value() {
  [[ -f .env ]] || return 1
  grep -E "^$1=" .env | tail -n1 | cut -d= -f2-
}

run_python() {
  "$PYTHON_BIN" "$@"
}

probe_fields() {
  local output
  output=$("$PROBE_BIN" --session --json 2>>"$LOG_FILE" || true)
  if [[ -z "$output" ]]; then
    log "probe=empty"
    return 0
  fi
  printf '%s\n' "$output" | jq -r '
    if .ok == true then
      "probe_ok=true wechat_front=\(.wechat_in_front) display_present=\(.display_name != null) last_time_present=\(.last_time_text != null) preview_present=\(.preview_text != null)"
    else
      "probe_ok=false error=\(.error // "unknown")"
    end' | tee -a "$LOG_FILE"
}

db_snapshot() {
  local label="$1"
  log "snapshot=$label"
  run_python - "$label" <<'PY' 2>>"$LOG_FILE" | tee -a "$LOG_FILE"
import os
import sys

from notalone.runtime_config import load_project_env

load_project_env()
import psycopg

label = sys.argv[1]
owner_id = os.environ["NOTALONE_OWNER_ID"]
url = os.environ["NOTALONE_DATABASE_URL"]

with psycopg.connect(url) as connection:
    state = connection.execute(
        "SELECT enabled FROM public.front_sync_state WHERE owner_id=%s",
        (owner_id,),
    ).fetchone()
    contacts = connection.execute(
        """
        SELECT c.id,
               EXISTS (
                   SELECT 1
                   FROM public.conversation_binding b
                   WHERE b.owner_id=c.owner_id
                     AND b.contact_id=c.id
                     AND b.channel='wechat'
                     AND b.status='active'
               ) AS bound,
               (SELECT count(*) FROM public.message m
                WHERE m.owner_id=c.owner_id AND m.contact_id=c.id),
               (SELECT count(*) FROM public.message_source_ref ref
                WHERE ref.owner_id=c.owner_id AND ref.contact_id=c.id
                  AND ref.source_kind='local_wechat_observation'),
               (SELECT cur.last_local_id
                FROM public.wechat_observation_cursor cur
                WHERE cur.owner_id=c.owner_id AND cur.contact_id=c.id),
               COALESCE((
                   SELECT obs.mode
                   FROM public.local_wechat_observation obs
                   WHERE obs.owner_id=c.owner_id AND obs.contact_id=c.id
                   ORDER BY obs.read_at DESC
                   LIMIT 1
               ), 'none'),
               (SELECT count(*) FROM (
                   SELECT metadata.external_local_id,
                          COALESCE(metadata.source_create_time, -1)
                   FROM public.wechat_message_metadata metadata
                   WHERE metadata.owner_id=c.owner_id
                     AND metadata.contact_id=c.id
                   GROUP BY metadata.external_local_id,
                            COALESCE(metadata.source_create_time, -1)
                   HAVING count(*) > 1
               ) duplicate_identities)
        FROM public.contact c
        WHERE c.owner_id=%s
        ORDER BY c.id
        """,
        (owner_id,),
    ).fetchall()

print(
    f"snapshot_label={label} "
    f"sync_enabled={state[0] if state else 'missing'} "
    f"contacts={len(contacts)}"
)
for contact_id, bound, messages, refs, watermark, mode, duplicates in contacts:
    print(
        f"contact_id={contact_id} bound={bound} messages={messages} "
        f"observation_refs={refs} watermark={watermark or 'none'} "
        f"latest_mode={mode} duplicate_identities={duplicates}"
    )
PY
}

show_runner() {
  if [[ -f "$RUNNER_LOG" ]]; then
    tail -n 14 "$RUNNER_LOG" | tee -a "$LOG_FILE"
  else
    log "runner_log=missing"
  fi
}

start_runner() {
  export NOTALONE_SYNC_PROBE="$PROBE_BIN"
  : > "$RUNNER_LOG"
  "$PYTHON_BIN" - <<'PY' >"$RUNNER_LOG" 2>&1 &
import os
import time
from datetime import datetime, timezone
from uuid import UUID

from notalone.front_sync.factory import (
    build_front_sync_engine,
    owner_wechat_account_scope,
)
from notalone.front_sync.tail_lifecycle import FrontSyncPhase
from notalone.runtime_config import load_project_env

load_project_env()
owner_id = UUID(os.environ["NOTALONE_OWNER_ID"])
database_url = os.environ["NOTALONE_DATABASE_URL"]
account_scope = owner_wechat_account_scope(database_url, owner_id)
if account_scope is None:
    print("runner=stopped reason=missing_active_wechat_identity", flush=True)
    raise SystemExit(2)

engine = build_front_sync_engine(
    database_url=database_url,
    owner_id=owner_id,
    account_scope=account_scope,
    cli_executable=os.environ.get("NOTALONE_WECHAT_CLI") or "wechat-cli",
    probe_executable=os.environ["NOTALONE_SYNC_PROBE"],
    follow_enabled=True,
)
print(
    f"runner=started follow_enabled=true sync_enabled={engine.sync_enabled()}",
    flush=True,
)
last_state = None
last_print = 0.0
try:
    while True:
        now = time.monotonic()
        report = engine.cycle()
        lifecycle = engine._lifecycle
        session = lifecycle._session
        stream = session.follow_stream if session is not None else None
        process = getattr(stream, "_process", None) if stream is not None else None
        pid = getattr(process, "pid", None) if process is not None else None
        watermark = session.since_local_id if session is not None else None
        state = (
            report.phase.value,
            report.probe_available,
            report.wechat_in_front,
            report.active_contact_id,
            bool(stream),
            pid,
            watermark,
            report.failure_code,
            report.batch_message_count,
        )
        if report.batch_message_count or state != last_state or now - last_print >= 2.0:
            stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
            print(
                f"cycle={stamp} phase={report.phase.value} "
                f"probe={report.probe_available} wechat_front={report.wechat_in_front} "
                f"contact_id={report.active_contact_id} "
                f"follow_stream={bool(stream)} follow_pid={pid or 'none'} "
                f"watermark={watermark or 'none'} "
                f"batch_messages={report.batch_message_count} "
                f"failure={report.failure_code or 'none'}",
                flush=True,
            )
            last_state = state
            last_print = now
        time.sleep(0.25)
except KeyboardInterrupt:
    print("runner=stopped reason=operator_interrupt", flush=True)
finally:
    lifecycle = engine._lifecycle
    lifecycle._stop_session(FrontSyncPhase.WAITING_FOREGROUND)
PY
  RUNNER_PID=$!
  log "runner_pid=$RUNNER_PID runner_log=$RUNNER_LOG"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if grep -q '^runner=started' "$RUNNER_LOG"; then
      break
    fi
    if ! kill -0 "$RUNNER_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  show_runner
  if ! kill -0 "$RUNNER_PID" 2>/dev/null; then
    warn "follow 观察进程未能保持运行。"
    return 1
  fi
}

stop_runner() {
  if [[ -n "$RUNNER_PID" ]] && kill -0 "$RUNNER_PID" 2>/dev/null; then
    kill -INT "$RUNNER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      if ! kill -0 "$RUNNER_PID" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    kill -TERM "$RUNNER_PID" 2>/dev/null || true
    wait "$RUNNER_PID" 2>/dev/null || true
  fi
  RUNNER_PID=""
}

cleanup() {
  stop_runner
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

finish_smoke() {
  _clear
  printf '\n%s%s  ✓ 人工冒烟向导结束%s\n' "$BOLD" "$GREEN" "$RESET"
  note "主日志：$LOG_FILE"
  note "follow 进程日志：$RUNNER_LOG"
  note "脚本没有修改 04 票；请把人工判断和剩余风险回传后再更新 Answer。"
  printf '\n'
}

banner "真实微信 tail --follow 只读冒烟（04）"

stage "预检与安全边界"
say "只检查运行环境；脚本不会自动 enable/disable 同步，不会创建绑定，不会发送微信消息。"
for command_name in conda jq; do
  if command -v "$command_name" >/dev/null 2>&1; then
    log "command=$command_name available=true"
  else
    warn "缺少命令：$command_name"
    exit 1
  fi
done
if command -v "$CLI_BIN" >/dev/null 2>&1; then
  cli_version=$("$CLI_BIN" --version 2>/dev/null | jq -r '.data.version // "unknown"' || true)
  if [[ -z "$cli_version" ]]; then cli_version=unknown; fi
  log "wechat_cli=available version=$cli_version"
else
  warn "找不到微信 CLI：$CLI_BIN"
  exit 1
fi
if [[ ! -x "$PROBE_BIN" ]]; then
  warn "探针不可执行：$PROBE_BIN"
  exit 1
fi
for key in NOTALONE_DATABASE_URL NOTALONE_OWNER_ID; do
  if [[ -n "$(printenv "$key" 2>/dev/null || true)" || -n "$(env_file_value "$key" || true)" ]]; then
    log "env=$key configured=true"
  else
    warn "缺少配置：$key"
    exit 1
  fi
done
PYTHON_BIN="$(conda run --no-capture-output -n NotAlone python -c 'import sys; print(sys.executable)' 2>>"$LOG_FILE" | tail -n1)"
if [[ ! -x "$PYTHON_BIN" ]]; then
  warn "NotAlone 环境 Python 不可用。"
  exit 1
fi
log "python_environment=NotAlone"
pause "预检完成后按 Enter 继续。"

stage "记录基线"
say "只输出联系人 UUID、消息/来源计数、独立水位和最新观察模式，不输出联系人名称或正文。"
db_snapshot "baseline"
note "至少需要一个 active 绑定；A→B→A 只有在数据库已有两个已确认联系人时才可验证。"
pause "已核对基线后按 Enter 继续。"

stage "前台会话与同步开关"
say "请你人工把微信置前，并选中已确认绑定的单聊；不要在脚本中发送消息。"
step "在微信中确认当前窗口是目标单聊，且不要滚动或切换到其他 App。"
step "在另一终端确认同步开关已是 enabled；如需修改，请你手动运行 notalone-front-sync enable。"
pause "微信和同步开关准备好后按 Enter；向导会读取一次只含状态字段的探针结果。"
probe_fields
db_snapshot "before_follow"
pause "已记录前台基线后按 Enter 启动真实 follow 观察。"

stage "follow 实时到达"
say "启动 follow 优先的临时观察进程；它只写既有本地观察/规范消息路径，终端和日志不显示正文。"
start_runner
step "请你从另一端手动让当前联系人产生一条普通文本消息；不要让本脚本或 Agent 代发。"
step "保持微信目标单聊在前台，等待消息到达后回到本终端。"
pause "消息已由你人工产生并等待观察后按 Enter。"
show_runner
db_snapshot "after_live_message"
note "请核对 runner 中是否出现 batch_messages>0、phase=active、watermark 单调推进。"
pause "已核对实时到达结果后按 Enter。"

stage "去重与水位"
say "保持 follow 空闲一段时间；重复事件不应增加规范消息，成功返回的水位不应回退。"
step "请保持当前联系人前台至少 10 秒，不要发送第二条消息。"
pause "空闲观察完成后按 Enter。"
show_runner
db_snapshot "after_idle"
note "duplicate_identities 应为 0；若消息数增加，请结合人工发送时间和 runner batch 判断。"
pause "去重与水位结果已记录后按 Enter。"

stage "follow 异常终止与恢复"
say "先确认 runner 日志中有 follow_pid；终止动作由你在另一个终端人工执行。"
show_runner
follow_pid=$(grep 'follow_pid=' "$RUNNER_LOG" | tail -n1 | sed -E 's/.*follow_pid=([^ ]+).*/\1/' || true)
if [[ -z "$follow_pid" || "$follow_pid" == "none" || ! "$follow_pid" =~ ^[0-9]+$ ]]; then
  warn "没有可验证的 follow PID，跳过人工 kill；请把该项记为未验证。"
  log "stream_kill=skipped reason=follow_pid_missing"
else
  follow_command=$(ps -p "$follow_pid" -o command= 2>/dev/null || true)
  if [[ "$follow_command" != *"--follow"* ]]; then
    warn "PID $follow_pid 当前命令不含 --follow，拒绝终止。"
    log "stream_kill=skipped reason=pid_validation_failed"
  elif confirm "确认进入人工终止步骤；你将自行执行 kill -TERM $follow_pid？"; then
    step "请你在另一个终端核对命令后执行：kill -TERM $follow_pid"
    pause "你已人工终止该 follow 子进程？"
    log "stream_kill=human_requested pid=$follow_pid"
    sleep 8
    show_runner
    db_snapshot "after_follow_restart"
    note "预期先看到 cli_follow_failed/退避，再看到 cli_catchup 后重新打开 follow；水位不能回退。"
  else
    log "stream_kill=skipped reason=human_declined"
  fi
fi
pause "异常恢复结果已记录后按 Enter。"

stage "前台与同步开关失败关闭"
say "以下动作由你人工完成；观察进程只读前台状态，不会自动切换窗口或开关。"
step "把微信切到后台或隐藏，等待至少 3 秒，再回到本终端按 Enter。"
pause "微信已离开前台？"
show_runner
db_snapshot "wechat_background"
step "你在另一个终端手动运行：conda run -n NotAlone notalone-front-sync disable"
step "等待 runner 显示 sync_disabled/follow_stream=false 后，再手动运行：conda run -n NotAlone notalone-front-sync enable"
step "重新把微信目标单聊置前；观察恢复时先从已有水位补读，再进入 follow。"
pause "关闭/开启与恢复动作都完成后按 Enter。"
show_runner
db_snapshot "after_reenable"
note "预期：后台/关闭期间不读、不写；恢复后水位连续，重复消息不增加。"
pause "边界结果已记录后按 Enter。"

stage "收尾与人工 Answer"
stop_runner
db_snapshot "final"
printf '%s\n' \
  "# Issue 04 人工冒烟结果草稿" \
  "" \
  "- 执行时间：$RUN_ID" \
  "- 主日志：$LOG_FILE" \
  "- follow 进程日志：$RUNNER_LOG" \
  "- 真实微信正文：未写入日志；请根据人工观察补充结论。" \
  "" \
  "## Checklist" \
  "" \
  "- [ ] follow 实时到达：人工确认新消息近实时到达，且无丢失/重复入库。" \
  "- [ ] 切换与切回：若本次有两个 active 绑定，记录 A→B→A 水位与 cli_catchup；否则标记未验证。" \
  "- [ ] 异常恢复：记录 kill follow 子进程后的退避、补读和重启结果。" \
  "- [ ] 前台/开关边界：记录后台、关闭、重新开启后的失败关闭与恢复结果。" \
  "" \
  "## Remaining risk" \
  "" \
  "- 只把日志中的状态、计数、水位和错误码带入票据；不要复制任何聊天正文。" \
  > "$ANSWER_FILE"
log "answer_draft=$ANSWER_FILE"
finish_smoke
