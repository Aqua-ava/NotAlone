# 03 — 本人记忆独立召回

**What to build:** 用户本人的记忆以 `owner_memory` 证据类型进入回复上下文，使用独立的 3 条 / 240 字符预算，与联系人记忆互不占用；提示中显式区分"关于联系人"和"关于用户本人"，证据顺序为消息、联系人记忆、本人记忆、继续候选；生成前后按 `owner_id` 重新读取并校验存在性、来源、状态、有效期与 revision；改写模式开启关系资料时同时注入两类；生产装配把本人记忆存储接入检索；回复证据表迁移放行 `owner_memory`。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 02 — 联系人记忆相关性召回

- [x] 本人记忆以 `owner_memory` 证据进入回复上下文，并可随回复快照落库
- [x] 双预算独立：本人记忆不占用联系人条数与字符预算，反之亦然
- [x] 复验只按 `owner_id` 重新读取；失效、删除或 revision 变化时拒绝旧快照
- [x] 本人证据与联系人证据在提示中可区分，顺序符合约定
- [x] 迁移 033 可在本机测试库重复执行
- [x] 生产装配后本人记忆能真正出现在回复依据中
- [x] 改写开启关系资料时同时注入联系人与本人记忆
- [x] 相关 `unittest` 与 PostgreSQL 集成测试通过

## Comments

## Answer

- 实现：本人记忆以 `owner_memory` 证据进入回复上下文，使用独立 3 条/240 字符预算、同一评分器与阈值 0.15；证据顺序为消息 → 联系人记忆 → 本人记忆 → 继续候选；生成前后只按 `owner_id` 复验存在性、来源、状态、有效期与 revision。检索端口新增 `search_owner_memories`（含 `memory_ids` 复验与评分排序），内存与 PostgreSQL 适配器共用同一召回实现；`RetrievedOwnerMemory` 补齐状态、有效期、置信度与相关度字段。生产装配接入 `PostgresOwnerMemoryStore`；迁移 033 放宽 `reply_context_evidence.kind` 约束，`install.sh` 与 `database/README.md` 同步；提示词明确区分联系人与本人依据。
- 审查修复：两轴 review 发现并修复——`has_relationship_memory_for_rewrite` 语义扩展后改名 `has_long_term_memory_for_rewrite` 并统一守卫文案；`ports.py` 文档空白；补“双预算互不占用”与“owner revision 变化拒绝复验”用例；`database/README.md` 补迁移清单。
- 验证：全量 891 项通过、3 项跳过；新增 owner 评分/复验/预算/顺序单测与 2 项 PostgreSQL 集成（评分排序、复验无分数）；迁移 033 在 `notalone_test` 重复执行通过并应用到本机 `notalone_dev`；真实链路集成测试验证 `owner_memory` 证据可落库；`mypy` 对变化文件无新问题。
- 数据影响：新增 owner 级只读召回；迁移只放宽证据类型约束，不改写已有数据；本地迁移仅应用于 `notalone_test` 与 `notalone_dev`。
- 剩余风险：未接入 owner 存储的旧装配会静默降级为空召回（生产装配已覆盖）；阈值与双预算数值待票 05 标定。
