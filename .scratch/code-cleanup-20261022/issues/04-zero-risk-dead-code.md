# 04 删除零风险死代码（25 行）

Triage: ready-for-agent
State: resolved

## 目标

删除全仓 0 引用的 5 处定义（25 行），并同步必要测试引用。

## 证据

`.scratch/code-audit-20261022/verify-unused.md` 可删清单。

## 范围

- `backend/src/notalone/memory/events.py:146-152` `event_meaning`（7 行）
- `backend/src/notalone/memory/organization_sdk.py:9` `PURPOSE_POLICY`（1 行）
- `backend/src/notalone/persistence/skill_port.py:76` `_VERSION_CONTENT_QUERY`（1 行）
- `desktop/src/renderer/ReplyGenerationGuidance.tsx:8-20` `DirectionGenerationNotice`（13 行）
- `desktop/src/renderer/local-history-sync.ts:8-10` `localHistoryFailureNotice`（3 行）
- 删除前对每个标识符再跑一次全仓 token 引用复核；有测试/文档引用则同步处理。

## 验收

- `cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest discover -s tests/unit -t . -v`（相关目录）通过。
- `cd desktop && npm run typecheck` 通过。
- 报告是否发现动态/字符串引用。

## Comments

- 2026-10-22 backend-cleaner 完成（5 处 25 行，全仓引用复核为 0；无动态/字符串引用）：
  1. 后端：`memory/events.py` 删 `event_meaning`（7）、`memory/organization_sdk.py` 删 `PURPOSE_POLICY`（1）、`persistence/skill_port.py` 删 `_VERSION_CONTENT_QUERY`（1）。
  2. 桌面（与 desktop-cleaner 协调，其确认不在 05/06 范围）：`renderer/ReplyGenerationGuidance.tsx` 删 `DirectionGenerationNotice`（13）、`renderer/local-history-sync.ts` 删 `localHistoryFailureNotice`（3，并同步过时注释）；仅动这两个文件。
  3. 复核：`git grep` 每个标识符仅剩定义/不同名私有函数（`_same_event_meaning`），无测试 import、无字符串/反射引用。
- 验证：`cd desktop && npm run typecheck` 通过（exit 0）；`python -m unittest discover -s tests/unit -t .` 2498 tests，13 failures + 1 error 与改动前基线完全一致（pgvector `ModuleNotFoundError: experiments` + memory_extraction 基线），无新增失败；`tests/unit/memory`、`tests/unit/persistence` 相关模块通过；`compileall src tests` 通过。
- 数据影响：无；纯删除未执行定义。
- 剩余风险：`front_sync/emoji_presentation_data.py` 仅被已删的 `emoji_tail.py` 引用，ticket 07 删除后成为生产 0 import（本轮未在清单内，未动，留给后续清理或接线）。
