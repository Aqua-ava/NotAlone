# SQLite 记忆管理与裁决

产品合同以[记忆与版本数据](../../../../../architecture/current/domain-data.md)、[裁决流程](../../../../../architecture/current/memory-processing.md)、[依赖与删除](../../../../../architecture/current/privacy-deletion.md)为准；本页只保留本模块的接口、装配和故障处理。

`memoryManagementMigration(version)` 追加独立DDL；已发布迁移不修改。`memoryManagementActions` 注册 `memory.importRun`、人工决定 `memory.applyDecision`、只读 `memory.read/history` 与时间线准备动作。旧 `memory.publishRun`、`memory.applyAutomaticDecision` 及其宿主方法已退役，自动写入只由真实裁决完成事务消费候选。

`SqliteMemoryManagement(storage, ownerId)` 由认证宿主构造；页面不提供owner。`importRun(runId)` 只从提取域真实 `verifiedExtractionOutput` 导入固定原稿。`decide` 接受用户动作、幂等键、候选状态修订或精确记忆版本与头修订；人工请求不能通过夹带 `system` 或执行授权字段进入自动路径；自动执行授权由裁决完成事务通过内部函数参数注入，不开放为HTTP或Tool。决定与正式版本、必要消息、精确capture_record引用和当前头在同一短事务闭合。

`createMemoryKnowledgeReader(sourceEligibility?)` 实现回复域的 `ReplyMemoryReader`，仅提供正式记忆头部 `list`、精确身份 `open` 与资格复验，不保留整池物化或待确认候选枚举开关。验收通过同一 `list/open` 合同展开，候选管理与来源检查沿各自领域入口。本人self映射owner；正式memory保留auto/confirmed区别。额外 `MemoryKnowledgeItem.headRevision` 必须随消费者的identity_json保留，`requireCurrent`同事务重验精确版本、当前头、来源和正文；保护操作也使旧快照失效。历史已冻结的 `memory_candidate` 只在 `requireCurrent` 内按精确身份复验其原未确认资格、时间和来源，否决、来源失效或删除仍拒绝旧材料；不能经 `list/open` 成为新回复输入。

`memoryManagementDeletionDomain` 必须列入统一删除 `domains` 与 `requiredDomains`。本域没有受管文件或正文缓存；删除沿来源索引、实际事件输入及版本前驱/恢复依赖反查，先由统一authority停写，再清正文、敏感请求指纹及实际来源关系。冻结任务贡献保留授权边界，不把同轮未使用消息变成每项产物的来源。删除期间管理读取返回空快照；旧决定墓碑/擦除状态阻止重放。文档域复用本模型与读取合同，不另建正式 memory 表。

正常宿主在提取完成后调用 `SqliteMemoryAdjudication.publishRun`。逐候选重新冻结当前范围修订及真实候选、正式版本与消息。空池可确定性新增；有旧资料时分批完成结构化裁决和独立关系核验，合并额外核验完整正文及所选全部来源。每种用途使用同名step和真实模型operation/call，复用宿主唯一provider/许可/预算；未决回执保持占用。每次调用的实际输入子集与全局资格基线分别记录，任何批次未知、来源失效、保护或头变化均不发布。

同轮范围互斥、重复请求复用和关闭排空使用同一在途登记，不另存一份待排空集合。成功或失败均撤下原登记；关闭先拒绝新工作，全部在途轮次结束后才释放模型端口，端口释放失败可重试关闭但不重新接纳。

单头更新追加自动版本。多父合并以一个主版本和每个被退役父的真实 `auto_retire` 决定同事务生效，不重复消费候选。恢复时页面提交 `expectedMergedParents` 当前快照，整组检查版本、头、当前保护和来源，再逐父追加真实恢复决定与版本；保护后解除需刷新，旧请求仍冲突。系统动作不开放为HTTP或Tool。

同事实且来源集合相同的重复资料，经真实裁决与关系核验后登记 `auto_noop` 决定。决定触发器原子消费候选为 `duplicate`，界面显示“已跳过重复资料”；不产生版本或改变当前头、保护及撤回状态。矛盾的动作目标字段在协议解析及提交复验时拒绝，不能被忽略后当作成功。

管理HTTP只开放GET范围读取与POST用户决定，Bearer认证且拒绝Origin/owner/system字段。Worker在registry用 `createReplyCandidateActions(memoryKnowledgeReader)` 安装正式消费者，宿主没有第二套知识查询或模型壳。

`MemoryKnowledgeItem.citationSources` 是实际语义引用，`qualificationSources` 是实际执行输入及版本祖先的资格依赖；`sources`为二者精确并集，供回复输入与删除闭包使用。管理DTO单列 `contributingContactIds`，本人页面按完整冻结贡献归属过滤，不能以B的单个引句把A+B任务展示为B独立资料。

`verificationState` 表示当前正文的来源语义核验，独立于用户采纳或自动来历。人工编辑采纳、修正和变化不继承模型原稿的已核验标签；已处理存档读取不重新要求原轮读取授权，未决候选和在途写入仍复验完整冻结授权。旧无具名核验链的资料保留并标待核验，不静默重写或销毁。

版本12在受控Worker中以固定SQL与校验许可重建用途和typed输入约束；事务外临时关闭FK，写锁内重验、复制及恢复索引/触发器，完整性与FK检查通过才提交，最后恢复FK。迁移1–11不变。读取提交后再用新快照检查租约，为接管提供返回前线性化检查点。

阶段实现和旧验收记录已移至[开发历史](../../../../../docs/history/backend-development-history.md)；历史数字不表示当前版本通过。
