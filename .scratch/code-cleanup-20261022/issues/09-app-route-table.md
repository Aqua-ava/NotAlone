# 09 app.py 路由表化（行为不变）

Triage: ready-for-agent
State: resolved
Blocked by: 01

## 目标

把 `BackendApp._handle_authenticated` 的约 56 条顺序子串路由抽成显式路由表（method + 匹配器 + handler），行为与响应完全不变；先补路由黄金测试再重构。

## 证据

`.scratch/code-audit-20261022/verify-structure-defense.md` 第二节 S1：`_handle_authenticated` :476-670（195 行、37 if-elif），15 处 `in path_value`、30 处 `startswith`；`app.py` 类体 2,555 行、321 行首 if/elif。

## 范围

- 先写黄金测试：对现有全部 `/api/...` 路由（可枚举 61 个字面量 + startswith 前缀）断言 method/path → handler/状态码，捕获当前行为（含 404 与子串歧义样例）。
- 再抽 `Route(method, matcher, handler)` 表 + `_match_route(method, path)`；`_handle_authenticated` 保留认证、上下文与异常包装，委托路由表。
- 不改端点行为、错误码、缓存头；不新增端点。
- 一次只搬一类前缀，保持可回滚的小提交（本 ticket 内可多提交，Lead 审核后合并）。

## 验收

- 黄金测试在重构前后均通过（先记录基线结果）。
- `python -m unittest tests.unit.server tests.integration.server` 相关用例通过；全量后端单测通过。
- 报告路由表行数、`_handle_authenticated` 行数、测试覆盖的端点数。

## Comments

- 2026-10-22 route-refactorer 完成：
  1. 先补黄金测试 `backend/tests/unit/server/test_route_dispatch_golden.py`（26 个用例、32 条 method+path 分派样本）：用 `create_app(owner_id=uuid4, token=…)` 构造 app，把全部具名 `_handle_*` 换成哨兵响应并断言「方法+路径 → 处理器与实参」，另覆盖内联路由（联系人增删改、凭据、表达偏好、Skill 整理、组织质量）的响应/适配器调用、前置守卫（401/400/503）与未命中 404；替换 `_skill_learning` 避免 `handle()` 的整理调度触库，测试不连数据库、不起服务器。基线：重构前该文件 26/26 通过，`discover -s tests/unit/server` 107/107。
  2. `backend/src/notalone/server/app.py` 抽显式路由表：新增 `_RouteRequest`、`_Route(methods, matcher, handler)`、`_match_route(method, path[, routes])`、`_LIFECYCLE_ROUTE_TABLE`（2 条：GET `/api/runtime/status`、POST `/api/runtime/shutdown`，先于全局守卫）与 `_ROUTE_TABLE`（23 条，顺序即协议，首个命中）；guards（runtime_stopping、owner_uninitialized）与未命中 404 保持原位。`_handle_authenticated` 197→43 行（`app.py` 3,972→4,271 行，类体 −9 行）。运行期状态/关闭与 6 处内联分支各抽为独立私有方法（`_handle_runtime_status`、`_handle_runtime_shutdown`、`_handle_contact_write`、`_handle_contact_list`、`_handle_layered_memory_quality`、`_handle_expression_preference_requests`、`_handle_skill_learning_requests`、`_handle_credentials`、`_handle_assistant_session_requests`），方法体逐字保留。
  3. 逐类前缀迁移、每步跑黄金测试：① 联系人/memory-processing/trace/quality/layered-memory；② overview/expression-preferences/skill-learning/messages/evidence/assistant-session/sources；③ reply/explore+generate/memories/imports+tasks/ledger/skills/credentials/setup/follow-smoke/sync 与两条 lifecycle 路由。子串/方法差异怪癖全部保留：`startswith("/api/skills")` 等无斜杠前缀、`endswith("/manual-confirmation")` 无 `/api/contacts/` 前置约束、`_is_trace_path` 任意子串、layered-memory 处理器沿用含查询串的完整路径、非 GET `/api/settings/credentials` 仍落 404。
  4. 行为差异：0。方法/路径组合差分脚本对 HEAD 的 25 个旧分支与新表逐条比较 259 条路径 × 8 种方法 = 2,072 个组合，首个命中 handler 无一不一致。
- 验证：`python -m unittest tests.unit.server.test_route_dispatch_golden` 26/26；`discover -s tests/unit/server -t .` 133/133；全量 `discover -s tests/unit -t .` 2,527 用例 13F+1E（全部为既有 `tests/unit/memory_extraction` 合成端口失败与 `tests/unit/experiments` 缺 `experiments` 模块的环境导入错误，与 HEAD 基线一致；`wechat_cli` 时序用例偶发，单跑通过）；`git diff --check` 通过。
- 数据影响：无数据迁移、无端点/响应码/错误码/缓存头/请求体解析变化。
- 剩余风险：`_ROUTE_TABLE` 顺序即协议，新增端点必须插在正确前缀顺序内并补黄金样本；黄金测试替换处理器，真实处理器内部逻辑仍由既有 suite 覆盖；`tests/integration/server` 为空包（无集成用例），真实库与 HTTP 层未在本机复跑；未提交，工作树仅本文件与黄金测试待 Lead 审核提交。
