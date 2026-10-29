# SQLite 记忆管理合同（08）

`memoryManagementMigration(version)` 追加独立DDL；已发布迁移不修改。`memoryManagementActions` 注册 `memory.importRun`、`memory.applyDecision`、内部 `memory.applyAutomaticDecision` 与只读 `memory.read`。

`SqliteMemoryManagement(storage, ownerId)` 由认证宿主构造；页面不提供owner。`importRun(runId)` 只从07真实 `verifiedExtractionOutput` 导入固定原稿。`decide` 接受用户动作、幂等键、候选状态修订或精确记忆版本与头修订；系统 `automatic` 不接受正文、不开放为HTTP或Tool。决定与正式版本、必要消息、精确capture_record引用和当前头在同一短事务闭合。

`createMemoryKnowledgeReader({includeUnconfirmed:false})` 实现12的 `ReplyKnowledgeReader`；默认仅当前正式版本，可显式开启独立未确认参考。本人self映射owner；正式memory保留auto/confirmed区别，候选始终unconfirmed。额外 `MemoryKnowledgeItem.headRevision` 必须随消费者的identity_json保留，`requireCurrent`同事务重验精确版本、当前头、来源和正文；保护操作也使旧快照失效。

`memoryManagementDeletionDomain` 必须列入05 `domains` 与 `requiredDomains`。本域没有受管文件或正文缓存；删除沿来源索引、完整冻结贡献和版本前驱/恢复依赖反查，先由统一authority停写，再清正文、敏感请求指纹及实际来源关系。删除期间管理读取返回空快照；旧决定墓碑/擦除状态阻止重放。后续09应复用此模型和读取合同，不新增第二套正式memory表。

当前测试仅覆盖合成供应商正常07输入及真实SQLite管理/删除事务；真实供应商语义质量、实际App和宿主组合以任务08最终Answer为准。

正常宿主在07结束后通过 `afterRunSettled` 调用 `publishRun`，仅使用已存核验结果，不新增模型调用。`memory.publishRun` 以 producer event 固定系统幂等键；已有决定不重复发布。管理HTTP只开放GET范围读取与POST用户决定，Bearer认证且拒绝Origin/owner/system字段。Worker在registry用 `createReplyCandidateActions(memoryKnowledgeReader)` 安装正式消费者，宿主没有第二套知识查询或模型壳。

`MemoryKnowledgeItem.citationSources` 是实际语义引用，`qualificationSources` 是完整冻结贡献及版本祖先的资格依赖；`sources`为二者精确并集，供12输入与删除闭包使用。管理DTO单列 `contributingContactIds`，本人页面按完整贡献归属过滤，不能以B的单个引句把A+B任务展示为B独立资料。
