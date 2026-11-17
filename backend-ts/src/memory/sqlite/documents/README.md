# SQLite 主题资料和长期概览

产品合同以[文档发布](../../../../../architecture/current/memory-processing.md)、[精确版本依赖](../../../../../architecture/current/reply-generation.md)、[来源删除](../../../../../architecture/current/privacy-deletion.md)为准；本页只保留本模块的接口、装配和故障处理。

场景文档的合同、校验与核验结果解析集中在 [`scenarios/document.ts`](../../scenarios/document.ts)，长期画像的校验、渲染与逐项发布选择集中在 [`profiles/document.ts`](../../profiles/document.ts)。两者提供不加载模型执行代码的纯业务规则，供工作区、事务发布和已知回执重放共同使用。各自的 `workspace.ts` 负责内存文档编辑、Tool 和模型执行，并兼容原有公开入口；`service.ts` 编排处理，`publication.ts` 负责来源复验和事务提交。

L3 工作区在构造时保存旧画像、场景、底层记忆及预算的深冻结副本；`generationContext()`、文档读取和编译共同使用它。生成运行器只接收工作区和变更场景 ID 等变更说明，不再另传一套画像、场景或记忆；变更场景仍从本次冻结集合解析，不增加输入范围。模型请求的字段、顺序、提示、工具和调用预算保持原合同。

文档领域的 `DocumentKnowledgeReader` 只提供文档读取、按段读取和资格复验；正式回复组合遵循 `reply/sqlite/candidates/contracts.ts` 的 `ReplyKnowledgeReader`，明确提供记忆 `list/open`、文档 `readDocuments` 和相应复验。所有操作在同一 SQLite 短事务内接收已确认的 `DiscussionScope`，文档项以 `kind: 'document'`、精确 `versionNo`、`publicationId` 与真实来源返回。联系人文档只属于该联系人，本人文档逐项核验实际来源；发布集合的成员是完整清单，不能逐条回退到其他轮次。

`SqliteMemoryDocuments.read({scopeKind,contactId})` 是范围资料视图；`readTask(taskId)` 返回该任务冻结的记忆／文档修订、前一发布集合及各阶段状态。`publishRun(runId)` 只供正常处理服务在记忆管理域的前置阶段后调用，发布后按同一合同切换范围指针；`laterStagesState(tx,ownerId,runId)` 是只读完成投影，仅当全部任务适用阶段结束、完整发布集合可用且无未解未知文档调用时返回 completed。

执行器的范围互斥、重复请求复用和关闭排空共用唯一在途登记，包含正常发布与已知回执的本地重放。成功或失败均撤下原登记；关闭先停止接纳，再等待全部已接纳工作结束后释放模型端口。端口释放失败可重试关闭，但不会重新开放工作。

`memoryDocuments.claim` 在同一短事务按任务策略、各阶段最新步骤和发布记录，决定领取主题、领取画像、仅补发布或暂无工作。正常推进、暂停后继续与启动恢复共用这条流程；执行器不解析 `readTask` 的展示投影决定运行，也不另读暂停后再领取。画像的当前主题集合及变更说明也在领取时按冻结基线和实际替换关系生成；`basis.ts` 的 `taskSceneVersions` 供领取、保存核验及已知回执重放共用，执行器不再另传 `saveScene` 的结果。原 `claimScene`／`claimProfile`／`runPaused` 具名动作已退役，内部阶段函数继续复验暂停、真实来源、冻结版本和未知调用。每个实际阶段单独登记及排空持有者，发布前仍由 `publication.ts` 复验完整集合；没有新增任务状态或数据迁移。

主题和概览队列随 `memoryExtraction.control` 的轮次暂停／继续及控制修订在同一事务更新；内部 `setRunSchedulePaused`／`resumeRunSchedule` 不再另注册独立的具名动作。图片显式重试仍在原重试事务中沿用这些内部函数。继续只重排已知失败，未知回执仍保留，正常到期时间不因暂停重新计算。

文档基线在本任务前置记忆阶段成功后、首个文档步骤冻结输入时捕获；零选中记忆也保存修订与原因，冻结后不在运行中追加或刷新。已验证记忆未变化的轮次以 `unchanged_memories` 明确不适用阶段重新发布同一完整集合，仍推进发布身份与范围修订。时间事实（`valid_at` / `invalid_at`）在整理、发布、页面与回复读取时复验，过期、损坏或待核验记忆不进入模型或生成。

迁移 13 由 `schema.ts` 提供，只在 Worker 的固定版本与完整校验和检查下执行；迁移 1–12 不变。来源删除接入统一删除的显式领域清单、发布资格撤销、迟到提交拒绝及完整排空；删除后晚到发布不会复活旧正文。合成存储、隔离入口与桌面页面验证不等同于真实模型语义质量或真实微信集成。
