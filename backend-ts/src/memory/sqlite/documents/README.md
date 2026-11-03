# SQLite 主题资料和长期概览

产品合同以[文档发布](../../../../../architecture/current/memory-processing.md)、[精确版本依赖](../../../../../architecture/current/reply-generation.md)、[来源删除](../../../../../architecture/current/privacy-deletion.md)为准；本页只保留本模块的接口、装配和故障处理。

下游消费合同沿用 `reply/sqlite/candidates/contracts.ts` 的 `ReplyKnowledgeReader`：`read` 和 `requireCurrent` 在同一 SQLite 短事务内接收已确认的 `DiscussionScope`，文档项以 `kind: 'document'`、精确 `versionNo`、`publicationId` 与真实来源返回。联系人文档只属于该联系人，本人文档逐项核验实际来源；正式组合由 `replyLocalKnowledgeReader` 同时提供记忆与文档读取，不能相互替换。发布集合的成员是完整清单，不能逐条回退到其他轮次。

`SqliteMemoryDocuments.read({scopeKind,contactId})` 是范围资料视图；`readTask(taskId)` 返回该任务冻结的记忆／文档修订、前一发布集合及各阶段状态。`publishRun(runId)` 只供正常处理服务在记忆管理域的前置阶段后调用，发布后按同一合同切换范围指针；`laterStagesState(tx,ownerId,runId)` 是只读完成投影，仅当全部任务适用阶段结束、完整发布集合可用且无未解未知文档调用时返回 completed。

文档基线在本任务前置记忆阶段成功后、首个文档步骤冻结输入时捕获；零选中记忆也保存修订与原因，冻结后不在运行中追加或刷新。已验证记忆未变化的轮次以 `unchanged_memories` 明确不适用阶段重新发布同一完整集合，仍推进发布身份与范围修订。时间事实（`valid_at` / `invalid_at`）在整理、发布、页面与回复读取时复验，过期、损坏或待核验记忆不进入模型或生成。

迁移 13 由 `schema.ts` 提供，只在 Worker 的固定版本与完整校验和检查下执行；迁移 1–12 不变。来源删除接入统一删除的显式领域清单、发布资格撤销、迟到提交拒绝及完整排空；删除后晚到发布不会复活旧正文。合成存储、隔离入口与桌面页面验证不等同于真实模型语义质量或真实微信集成。
