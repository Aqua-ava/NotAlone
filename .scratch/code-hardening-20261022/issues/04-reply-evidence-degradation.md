# 04 回复依据降级可见

Triage: ready-for-agent
State: resolved

## 目标

回复依据读取失败不再被当成「没有资料」：分层资料/关系概览读取异常记 warning，并在 ReplyContext/回执中与「确实没有」区分。

## 证据

- `backend/src/notalone/reply/context.py:600-606`（`capture` 异常 → snapshot=None）、`:663-670`（`read_contact/read_owner` 异常 → None）。
- `ContextReceipt`（`reply/interface.py:236-241`）不暴露 retrieval 失败。
- 复核：`verify-backend.md` A4。

## 范围

- `context.py`：异常路径 `logger.warning(exc_info=True)`；新增明确状态（如 `layered_status="read_failed"`、概览读取失败标记），不改写既有 `quality_closed/not_allowed/loaded/unavailable` 含义。
- `interface.py` 回执：暴露读取失败状态（只加字段）。
- 桌面是否展示留到后续，不在本 ticket 扩大。
- 测试：fake layered/overview 抛错，断言状态与日志；正常空资料仍为 `unavailable`/现有语义。

## 验收

- 单测 + reply 相关模块；报告新增字段对既有序列化/桌面解析的兼容性。

## Comments

1、改动：`reply/context.py` 在分层资料 `capture` 与概览 `read_contact/read_owner` 的异常路径各记 `logger.warning(..., exc_info=True)`（日志只含 scope 侧与降级原因，不含正文/路径/身份），并新增只增不减的失败标记：`ReplyContext.layered_read_failed`/`owner_layered_read_failed`/`overview_read_failed`；既有 `layered_status` 取值（`quality_closed/not_allowed/loaded/unavailable`）含义与取值不变，读取失败仍走 `unavailable`，由标记区分「确实没有」。`interface.py` 的 `ContextReceipt` 增补同三项 `bool` 字段（默认 `False`，仅加字段）；InMemory 与 PostgreSQL `save`、PostgreSQL `_context_snapshot`/`_read_result` 同步透传，旧快照缺键按未失败读取（`_snapshot_flag` 对非 bool fail closed）。`prepared_context_codec.py` 因 `ReplyContext` 结构演进按仓库约定把 `CONTEXT_SCHEMA_REVISION` 14→15，旧固定快照要求重新准备。

2、兼容性：`ContextReceipt` 字段追加在末尾且带默认值，Python 侧既有构造/比较不受影响；`server/app.py` 的 generation JSON 投影未改（本 ticket 不扩桌面展示），桌面 `layered-evidence-read.ts` 只白名单既有 status 值，因此未新增 `read_failed` 状态值、不破坏既有解析。PostgreSQL `context_snapshot` 新增 JSON 键，旧行缺键按 `False` 读取，不回写旧数据。

3、边界：未改来源核验、删除、人工保护、候选人范围与发送边界；未新增外发能力；日志不含消息正文、真实路径、凭据或可识别个人信息。

4、验证：`cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.unit.reply.test_reply_evidence_degradation tests.unit.reply.test_prepared_context_codec -v`（15 tests OK，含新增失败路径/日志/回执/快照标记用例）；`... python -m unittest discover -s tests/unit/reply -t .`（454 tests OK）；`... discover -s tests/unit/application -t .`（99 tests OK）。`discover -s tests/unit/experiments -t .` 有 1 个既有失败（`test_pgvector_evidence` 依赖未迁移的 `experiments` 包，见 spec C1，与本改动无关）。

5、数据影响：无生产数据迁移；新读取失败标记只出现在新生成/新落库的回复上下文与固定准备快照。旧固定准备快照（revision 14）在升级后解码失败并按既有契约要求重新准备（fail closed），不会静默补字段。

6、剩余风险：桌面端尚未展示该标记（按 ticket 范围留后续）；`application/reply_evidence.py` 证据投影与 `server/app.py` 序列化未暴露新字段，重启后再读完成回复只能从本 ticket 新增的快照键恢复回执标记（已实现），但 HTTP/桌面可见性仍待后续 ticket。

- 2026-10-22 复核修复：日志改为只记稳定码 + 异常类型名（不再 `exc_info=True`，避免路径/SQL 细节）；HTTP `context_receipt` 追加 `layered_read_failed`/`owner_layered_read_failed`/`overview_read_failed` 三个字段并补投影单测。此前 Comments 中 `exc_info=True` 的描述已失效，以本条为准。
- 提交：`d8979200、57074c47、d31491a5`。
