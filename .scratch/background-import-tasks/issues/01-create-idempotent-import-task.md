# 01 — 导入创建幂等后台任务

**Triage:** ready-for-agent
**State:** open

**What to build:** 导入一份已经确认 owner 和联系人的单联系人来源后，在同一业务事务中创建一份可查询、可恢复的导入后台任务及固定步骤。重复提交同一来源时复用原任务和状态，不产生第二份任务或消息。

**Blocked by:** None — can start immediately.

- [ ] 成功导入后创建一份 `background_task`，范围明确绑定 `owner_id + contact_id + source_document_id`。
- [ ] 按固定顺序创建 `parse`、`normalize`、`extract_memory`、`index`、`verify` 步骤，并记录每一步的初始状态和顺序。
- [ ] 来源、消息、联系人确认和任务记录在同一事务中提交；任一步失败都不留下孤立任务。
- [ ] 同一来源重复提交返回已有导入结果和任务结果，不重复写入消息或任务。
- [ ] 任务状态可以被查询，至少能显示当前状态、当前步骤、消息数量、创建时间和关联来源 ID。
- [ ] 任务记录不保存聊天正文、raw JSON 或模型完整输入输出。
- [ ] 使用合成 PostgreSQL 数据覆盖首次创建、重复提交、失败回滚和 owner/contact 隔离。

## Comments

- 来源规格：`.scratch/background-import-tasks/spec.md`。
