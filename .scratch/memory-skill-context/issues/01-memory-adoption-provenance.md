# 01 — 关系记忆采纳与来源证据

**What to build:** 用户在真实消息产生关系记忆候选后，可以看到候选的来源、可信度、风险和有效期；低风险且明确的资料按规则自动采纳并标记为 `auto`，敏感关系推断保持待确认状态。用户可以确认、修改、拒绝或撤销记忆，且旧版本和来源仍可追踪。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent
**State:** resolved
**Triage:** ready-for-agent

- [x] 真实 Message 只在成功提交后进入异步提取，候选带有当前 Owner、联系人、来源消息、置信度、风险和有效期。
- [x] 低风险且明确的候选可以按 allowlist 自动采纳为 `confirmed_memory`，记录 `auto`、来源和可撤销关系。
- [x] 敏感关系推断在用户确认前保持候选状态，不进入默认回复上下文。
- [x] 用户可以查看来源、接受、编辑、拒绝和撤销；更新创建新版本，旧版本标记失效而不是静默覆盖。
- [x] 重复提取和重复任务幂等，不产生重复候选或确认记忆。
- [x] 采纳规则与现有关系记忆架构决策完成明确复审，不能静默覆盖既有决定。
- [x] 使用合成或匿名化数据覆盖来源缺失、冲突、过期、越权和删除后的行为。

## Answer

已完成关系记忆采纳与来源证据纵切：

1. `MemoryCandidate`、`ConfirmedMemory` 和 owner 级记忆保留置信度、风险标签、来源、有效期；PostgreSQL 迁移 027 增加字段、`extract_failed` 状态和版本链字段，并让已有安装通过 `scripts/install.sh` 补应用。
2. `MemoryAdoption` 对自动采纳采用 fail-closed 风险 allowlist：低风险且达到门槛才写入 `confirmed_memory`；敏感或未知风险只保存为 pending。相同联系人、主题、正文和来源集合的 pending 重复提取幂等。
3. 手动确认、撤销和 API 展示保留来源与裁决元数据；修正创建新的 manual 版本，旧版本标记 invalidated，并通过 `supersedes_memory_id` 可追踪。新增 ADR-024 明确修订 ADR-002 的风险门槛规则。
4. 只使用合成 owner、联系人、来源和消息；未增加任何外部聊天发送能力，也不把 pending 候选放入已确认检索。

验证：`python -m unittest discover -s tests/unit`（341 个通过）；关系记忆、采纳、Memory API 与 PostgreSQL 集成测试（49 个通过）；`python -m compileall -q src tests` 和 `git diff --check` 通过。迁移 027 在隔离的 `notalone_test` 上首次执行和重复执行均成功。
