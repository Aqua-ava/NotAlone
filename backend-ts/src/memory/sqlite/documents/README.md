# SQLite 主题资料和长期概览（09，实施中）

下游消费合同沿用 `reply/sqlite/candidates/contracts.ts` 的 `ReplyKnowledgeReader`：`read` 和 `requireCurrent` 在同一 SQLite 短事务内接收已确认的 `DiscussionScope`，文档项以 `kind: 'document'`、精确 `versionNo`、`publicationId` 与真实来源返回。联系人文档只属于该联系人，本人文档逐项核验实际来源；接线时应组合 08 的记忆读取，不能替换它。发布集合的成员是完整清单，不能逐条回退到其他轮次。

`SqliteMemoryDocuments.read({scopeKind,contactId})` 是范围资料视图；`readTask(taskId)` 返回该任务冻结的记忆／文档修订、前一发布集合及各阶段状态。`publishRun(runId)` 只供正常处理服务在 08 的前置阶段后调用。上述实现与接线仍在进行，本文不作为功能或桌面验收通过的证明。

迁移 13 由 `schema.ts` 提供，只在 Worker 的固定版本与完整校验和检查下执行；迁移 1–12 不变。来源删除接入 05 的显式领域清单、迟到提交拒绝及完整排空尚在实施，不能将当前空集合测试当作删除或正常模型集成通过。
