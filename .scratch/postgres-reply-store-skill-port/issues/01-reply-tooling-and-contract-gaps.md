# 回复链路语义缺口（第二轮审查遗留项）

Triage: needs-triage
State: open

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

## Comments
