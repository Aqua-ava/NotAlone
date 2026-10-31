# SQLite 候选回复与依据（实施12）

`replyCandidateMigration(version)` 仅追加新版本。候选稳定身份不保存正文，模型原稿从 v1 起；手工编辑追加同候选父版本，多条消息分别按 `part_no` 保存。选稿是固定版本的追加事件，不证明复制或发送。

`SqliteReplyCandidateService` 提供 begin/view/version/edit/select；`SqliteReplyTurns` 复用11的真实DSH运行、共享provider/arbiter及07调用账本。`reply.begin`复用11请求键、身份与unknown保护，保存真实触发发言和历史覆盖依据。联系人资格通过后可立即生成，历史未开始、同步中或不完整均不阻塞，也不要求额外确认；覆盖事实和当前可用资料限制进入冻结输入与输出依据，不将部分覆盖标成完整。旧 `accept_incomplete` 字段仅兼容已有调用，不授予读取或改变生成资格。原请求重试使用受理时的覆盖快照，不随后台历史进度改写或重复调用。任何重开、选稿、编辑和回看均不发送模型请求。

`contracts.ts` 的 `ReplyKnowledgeReader.read/requireCurrent` 是08/09消费者接点：两者均在当前SQLite短事务调用；输入由宿主注册，HTTP不能提供正文、版本资格、SQL或adapter。`ReplyKnowledgeItem` 固定真实版本、本人／联系人范围、资格、发布集合及精确 `capture_record.id` 来源。正式写者负责核验精确版本及publication成员；本票再核验范围、来源与解释修订。生产Worker已接入08的正式记忆读取器；缺少正式文档消费者时文档集合为空，不能把07提取原稿当成已采纳记忆。未确认候选有明确标注。13本轮暂缓，不读取或保存长期表达偏好。

`reply_candidate_context` 冻结本人／联系人memory/document修订，即使本次没有选择材料也保留。`reply_candidate_input` 是在11现有输入类型之外增量安装的真实候选输入快照；不重建或修改已发布的7版context表，也不伪造08/09父表。每项知识版本由消费者同事务验证，正文与全部来源不可改写。`reply_execution_input` 将这些快照绑定到真实model_request事件；`event_source_planned` 新迁移保留原三分支并追加这一真实输入分支。展示依据仅引用这次call的实际输入，不能替代完整来源闭包。

候选执行每次重建独立受管DSH副本，以避免未选择的旧候选通过SDK历史进入下一请求。只有同讨论的真实selection可以显式携入；携入固定正文版本及原始输入来源。Skill仍由14的官方provider读取，assertCurrent/recordSelection/recordInput及写事务requireSkillRun沿11真实合同，不以selected冒充loaded，不改变原目录。

`replyCandidateDeletionDomain` 必须列入requiredDomains，并在discussion_calls前释放候选FK；其余原有域顺序保持。来源闭包由11收集，增量纳入知识/选稿完整来源及后续显式携入请求。fence立即撤下候选正文与依据、不可逆清除版本资格；05排空持有者后清实际输入、选择、版本、调用追踪及11完整受管文件。候选域自身没有文件目标，不能声称只删本域即完成删除。

当前合成证据：`test/sqlite-reply-candidates.test.mjs`，外部渠道与供应商为明确本机合成边界，SQLite/历史服务/官方DSH/provider/arbiter/文件均为真实实现。认证HTTP及正常官方profile端到端已有独立合成回归，实际开发App完成生成、多条编辑、固定版本选稿、原版回看、重开与联系人切换；实际Skill停用后旧草稿、候选、依据及Skill快照共同撤下，权威重读不恢复。实际07→08发布→12读取→05跨联系人来源删除，以及08人工建立／修正／保护→12旧选稿失效已通过最小组合；这不证明08自动关系裁决已经完成。09正式文档写者组合仍是20切换前门禁，真实外部模型质量未验证。

前台确认资格由正常ForegroundController同时注入候选主进程门禁和页面禁用/撤快照边界，不能只靠renderer传confirmed_contact。SQLite讨论已识别后隐藏旧PG候选与长期偏好入口。当前Skill选择只作用本次，页面展示的是实际加载事件；Skill库变更在请求开始即撤销旧快照，失败也不保留旧正文。

页面在失效事件、操作明确拒绝或权威重读发现旧请求失效时，清除候选、草稿、编辑、携入和Skill快照；短暂网络失败只保留原请求键、草稿及无正文的来源标识，后续权威确认失效时仍能撤下旧草稿。
