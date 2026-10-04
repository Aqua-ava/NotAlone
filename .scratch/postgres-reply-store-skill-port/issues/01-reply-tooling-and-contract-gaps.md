# 回复链路语义缺口（第二轮审查遗留项）

Triage: ready-for-agent
State: resolved

## 背景

2026-09-18 第二轮只读审查发现回复链路几处语义缺口。同轮已修复：幂等重放不校验 skill 选择（`_normalize_input` 加入 skill 字段）、InMemoryReplyStore 与 PostgresReplyStore 的 `_validate_context`/`_validate_reply` 契约对齐（citation ⊆ evidence、current_text/skill_library_revision/risk_notes 校验）、失败路径台账失败掩盖原始异常（新增 `_record_failure_ledger`）、`reply_service._reason_for` 死代码。以下为遗留项。

## 遗留项

1. **HistoryTool 把跨会话消息统一标注为当前绑定 session_id**（`reply/tools.py:334` `_message_payload`）：`conversation_search` 按 contact 范围检索，返回 payload 的 `session_id` 全部标成当前绑定 ID，模型收到失真的证据元数据，可能把同联系人其他桌面会话的上下文当作当前对话。不越权（仍在已确认联系人范围），但来源标注失真。需要设计决定：透传消息真实 session_id 或在检索层限制会话。
2. **HistoryTool 对"仍当前有效"的消息整体判死**（`tools.py:316-321`）：`invalid_at is not None` 即 raise，与 context `_is_current`（`now < invalid_at` 才有效）语义冲突；未来时间的 `invalid_at` 会让整次生成按 REJECTED_BY_VALIDATION 失败。当前 PG 检索不产出 `invalid_at`，仅 InMemory 夹具可触发，但消息层引入定时失效即变成全量拒绝。
3. **证据条数上限误用 token 预算常量**（`tools.py:263-266`）：`len(self._evidence) + len(validated) > MAX_HISTORY_TOKEN_BUDGET`（2048）当作条数上限，实际不可达，等于没有条数上限；应由 top_k×调用数之外引入独立小额条数常量。
4. **`_mark_failed` 吞掉 store.fail 异常**（`generator.py` `except Exception: pass`）：请求停留 running 至租约过期自愈；错误完全隐藏、无日志点。建议至少计数或接入可观测性。
5. **`_version_snapshot` 读取异常 fail-open**（`context.py:693-716` `except Exception: return (None, None)`）：瞬时 DB 故障使本轮 `memory_revision=None`，`validate_current` 对 None 跳过比较，本轮生成期间记忆目录全局变化不再检测；与 validate 阶段的 fail-closed 不对称。逐条证据复验仍兜住进入证据的记忆，损失的是粗粒度 tripwire。设计取舍：可用性 vs 全量拒绝，需要决策。
6. **skill_preview 的 load_version/load_resource 未钉扎构造 scope**（`adapters/skill_preview.py:49-62`）：`catalog()` 钉了，版本/资源读取依赖 PG port 内部 scope 过滤兜底，属加固缺口。

## 为什么测试没抓到

历史工具夹具不设置 session_id 与未来 invalid_at；无"证据条数上限"断言；无 reader 抛异常用例；单测走 generator→store 全链路使 store 层缺口成为死代码差异（InMemory 差距部分已在同轮补齐测试）。

## Answer

2026-09-18 已修复遗留项 3：历史 Tool 新增与 2048 token 预算独立的 16 条证据上限；在最多 3 次、每次最多 8 条的现行调用预算下，第三次大结果会在进入证据前拒绝。合成测试用三组各 8 条的不重叠短消息证明该上限可实际触发且不会污染已有 16 条证据。其余遗留项尚未处理，本 ticket 保持 open。

## Comments

- 2026-10-04：收尾分类。6 条遗留项中 3 条已修好：证据条数上限已独立成 16 条常量、`_mark_failed` 不再静默吞异常（新增 logger warning 与 `assertLogs` 测试）、`skill_preview` 的版本／资源读取已钉扎构造 scope；`statement_timeout` 这条也已在回复链路补齐（`reply/context.py` 与 `retrieval/evaluation.py` 现在显式传 500ms，并与历史 Tool 默认一致，附假连接单测）。本机在临时 `_test` 库上跑通持久化 288 项、服务端 149 项、回复 6 项集成测试。
- 2026-10-04：剩下 3 条需要产品决定，保持 open：①`HistoryTool` 把跨会话消息统一标注当前绑定 `session_id`——是透传真实会话还是限制检索范围，会改变模型可见的证据元数据；②未来 `invalid_at` 在消息层被整体判死与 context 的 `now < invalid_at` 语义冲突，需要定契约（消息表当前不产出该字段）；③`_version_snapshot` 读取异常 fail-open 与校验阶段 fail-closed 不对称，属可用性 vs 全量拒绝的取舍。三条都不是缺陷修复，改前需要用户确认语义。

- 2026-10-04：三条待决语义已按“不伪造、与校验口径一致、fail-closed”收口并落地：①历史 Tool 只透传检索层给出的真实 `session_id`，取不到时为 null，不再把跨会话消息标成当前绑定会话（新增透传与 null 两侧用例）；②未来 `invalid_at` 不再整体判死，只有 `now >= invalid_at` 才算失效，与 `context._is_current` 一致（新增未来／过去用例）；③`_version_snapshot` 读取失败改为抛 `ReplyContextError`，不再返回 `(None, None)` 让本轮失去 tripwire。单元 738 项、回复集成 6 项通过。本票 6 条遗留项全部处理完毕。
