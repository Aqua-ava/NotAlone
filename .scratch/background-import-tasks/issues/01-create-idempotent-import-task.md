# 01 — 导入创建幂等后台任务

**Triage:** ready-for-human
**State:** resolved

**What to build:** 导入一份已经确认 owner 和联系人的单联系人来源后，在同一业务事务中创建一份可查询、可恢复的导入后台任务及固定步骤。重复提交同一来源时复用原任务和状态，不产生第二份任务或消息。

**Blocked by:** None — can start immediately.

- [x] 成功导入后创建一份 `background_task`，范围明确绑定 `owner_id + contact_id + source_document_id`。
- [x] 按固定顺序创建 `parse`、`normalize`、`extract_memory`、`index`、`verify` 步骤，并记录每一步的初始状态和顺序。
- [x] 来源、消息、联系人确认和任务记录在同一事务中提交；任一步失败都不留下孤立任务。
- [x] 同一来源重复提交返回已有导入结果和任务结果，不重复写入消息或任务。
- [x] 任务状态可以被查询，至少能显示当前状态、当前步骤、消息数量、创建时间和关联来源 ID。
- [x] 任务记录不保存聊天正文、raw JSON 或模型完整输入输出。
- [x] 使用合成 PostgreSQL 数据覆盖首次创建、重复提交、失败回滚和 owner/contact 隔离。

## Comments

- 来源规格：`.scratch/background-import-tasks/spec.md`。

## Answer

已完成：新增 016 迁移、后台任务模型和 PostgreSQL 状态仓储；正式导入在同一事务中创建 queued 的
`import` 任务与五个 pending 步骤。`ImportResult` 返回 `task_id`，重复来源复用原任务，任务状态
查询只返回范围、状态、步骤、计数和时间等非正文元数据。

验证：合成 PostgreSQL 导入/任务集成测试 26 个通过，全套测试 249 个
通过、2 个既有权限跳过；016 迁移在 `notalone_test` 和 `notalone_dev` 均重复执行成功；编译与
`git diff --check` 通过。

后续：来源软删除停止任务和 Worker 的租约、重试、模型/规则版本元数据分别留给票据 02、04，
本票不提前改动。
