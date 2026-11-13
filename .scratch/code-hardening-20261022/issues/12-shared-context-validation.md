# 12 共享上下文校验

Triage: ready-for-agent
State: resolved

## 目标

三份 `_validate_context` 收敛为一个纯函数/共享实现，generator、Postgres reply store、InMemory store 只做薄包装，规则不再漂移。

## 证据

- `reply/generator.py:342`（约162行）、`persistence/reply_store.py:896`（约157行）、`reply/store.py:546`（约133行）。
- 三份各有独有不变量：按输入模式、require_explored_context + assistant_discussion + 回表比对、InMemory 缺一组。
- 复核：`verify-backend.md` A5。

## 范围

- 抽出 `reply/context_validation.py`（或同等 seam）纯函数：输入 command/context/读候选回调，输出校验结果；per-mode 不变量并入。
- 三处改薄包装；InMemory 不再缺规则。
- 不改写业务规则本身；若发现规则冲突，记录在 Comments 并按更严格一侧统一（fail-closed）。
- 测试：现有 reply 校验/越权相关测试全绿 + 新增三实现一致性参数化测试。

## 验收

- reply 相关单测/集成；报告行为差异点与统一依据。

## Comments

1、改动：新增 `backend/src/notalone/reply/context_validation.py` 作为唯一规则来源。`validate_reply_context(context, *, command | binding, continued_candidate_text)` 是纯函数：校验快照结构、证据契约、Tool 轨迹、助手讨论绑定、继续候选与 per-mode 不变量，返回 `frozenset[UUID]` 证据集；生成入口传 `command`，持久化入口传 `ReplyContextBinding`（从 `ReplyRequest` 投影 request_id/scope/normalized_input/idempotency_key/conversation_binding_id/continued_from_candidate_id）。`canonical_reply_input`/`normalize_reply_input` 与 `valid_tool_call_trace` 一并迁入共享模块（`reply/store.py` 保留同名 re-export，`persistence/assistant_session_store.py` 等既有导入不变）。三处 `_validate_context` 变成薄包装：generator 只把 `ReplyContextValidationError` 映射为 `ReplyInvariantError`；两个 Store 映射为 `ReplyStoreInvariantError` 并各自提供候选回表回调；Postgres 包装层额外保留 `require_explored_context` + DB 候选查询（数据库能力，不是重复规则）。

2、规则冲突与统一依据（均按更严格一侧 fail-closed，未放宽任何校验）：a) per-mode 不变量（ReplyToMessage 目标消息/方向、InitiateConversation 目的、RewriteDraft 草稿与历史授权）原本只在 generator 执行 → 并入共享函数后 InMemory/PostgreSQL 落库边界同样执行；b) `assistant_discussion` 与请求绑定原本只在 PostgreSQL 校验 → 共享后 generator/InMemory 也校验（generator 以 `context.command.idempotency_key` 为权威）；c) 继续候选：三处都校验「显式选择 + 唯一 evidence + id 一致」，文本回表从「仅 Store」扩展为 generator 也用 `Store.start` 返回的 `continued_candidate` 快照比对（无候选权威时仅校验 id，属入口能力差异，不是规则放宽）；d) `ToolCallTrace` 三份逐字相同的校验合并为一份，证据 kind/status/时间/revision/pending 标注校验合并为一份；e) 错误消息统一由共享函数产出，三个 adapter 各自映射错误类型，公开错误类型契约不变（`ReplyInvariantError` / `ReplyStoreInvariantError`）。

3、测试：新增 `backend/tests/unit/reply/test_context_validation.py`（11 tests）：三实现参数化一致（3 种合法输入模式 + 方向/目标文本/主动目的/草稿历史/缺草稿证据/重复 evidence id/跨联系人 scope/未知 Tool 证据/助手讨论 scope/继续未显式选择/继续 id 不一致等拒绝用例）、共享函数必须持有请求权威、返回证据集、两 Store 绑定不一致与共享错误文本一致、generator 与 PG 包装层的继续候选文本回表。并更新因「统一为更严格规则」而必须修正的既有夹具：`test_evidence_contract.py` 断言四边界委派同一共享校验函数；`test_langchain_vertical_slice.py` 的假 Store 补 `continued_candidate`（与真实 Store 契约一致）；`test_overview_navigation.py` 补 ticket 04 的 `overview_read_failed` 断言；`tests/integration/server/test_reply_evidence_api.py` 改为合法 ReplyToMessage 上下文；`tests/integration/persistence/reply_deletion_contract.py` 草稿用例补本次 `user_draft` 依据并在引用 owner_memory 时显式 `include_relationship_context=True`；`tests/integration/persistence/test_postgres_reply_store.py` 的时间快照用例保留目标消息依据后追加记忆证据并按 evidence_id 断言。

4、实际验证（`cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" …`）：`python -m unittest tests.unit.reply.test_context_validation` → 11 tests OK；`discover -s tests/unit/reply -t .` → 465 tests OK；`discover -s tests/unit/application -t .` → 99 tests OK。PG/集成（`NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_test`）：`test_postgres_reply_store` 19 OK、`test_source_reply_deletion` 9 OK、`test_observation_reply_deletion` 8 OK、`test_assistant_candidate_versions` 16 OK、`test_assistant_discussion_context` 29 OK、`test_reply_discussion_dependencies` 11 OK、`test_assistant_generation_replacement` 14 OK、`test_explored_generation` 8 OK、`tests.integration.server.test_reply_evidence_api` 5 OK。
   为区分并行改动，另用「`git archive HEAD` 快照 + 本 ticket 全部改动文件」隔离副本复跑：unit reply 465 OK、`test_postgres_reply_flow` 8 OK、`test_source_reply_deletion` 9 OK、`test_observation_reply_deletion` 8 OK；`test_postgres_reply_store` 中 skill 目录用例因隔离副本缺少 skill-fix 未提交的 `synchronize_skill_library` 而 import 失败（共享工作树实跑 19 OK），记忆时间快照夹具单测在隔离副本 1 OK。
   共享工作树里 `test_postgres_reply_flow` 的失败来自并行 Agent 未提交 skill 改动（continuation `require_saved_skill_policy` 与 `basis_changes=skill_policy_changed`）；`test_reply_revalidation_batches.test_historical_id_reads_exact_version_without_ancestor_rows` 在改动前 HEAD 基线同样失败，属既有问题（非本 ticket）。全量 unit：2487 tests 中 13 failures + 2 errors，全部位于 memory_extraction/wechat_cli/experiments（并行改动或既有问题），reply 相关全绿。

5、数据影响：无 schema、迁移或生产数据变更；校验统一后更严格的 fail-closed 只影响「本就不合法的历史上下文」，正常生成/落库路径不变；`reply_request`/`reply_candidate` 写入行为与字段未改。

6、剩余风险：generator 只在 Store 返回 `continued_candidate` 时做文本回表（Store 违约返回 None 时仍校验 id）；`require_explored_context` 与 DB 候选查询因依赖数据库能力留在 Postgres 包装层；真实 App/微信与桌面未运行（本轮按 spec 以自动测试为准）。此外 Go/桌面侧如果未来新增 ReplyStore adapter，需要复用同一共享校验函数与 `ReplyContextBinding`。

7、共享文件归属：`backend/tests/integration/persistence/test_postgres_reply_store.py` 同时包含 skill-fix 尚未提交的 skill library 夹具改动（`synchronize_skill_library` 调用，属并行 ticket 必要夹具），按 Lead 协调随本 ticket 一并提交；未回滚或改写该段夹具。本 ticket 只改该文件的记忆时间快照用例（第 455-495 行区域）。
- 提交：`d28f43ea`。
