# SQLite 候选回复与依据（实施12）

`replyCandidateMigration(version)` 仅追加新版本。候选稳定身份不保存正文，模型原稿从 v1 起；手工编辑追加同候选父版本，多条消息分别按 `part_no` 保存。选稿是固定版本的追加事件，不证明复制或发送。

`SqliteReplyCandidateService` 提供 begin/view/version/edit/select；`SqliteReplyTurns` 复用11的真实DSH运行、共享provider/arbiter及07调用账本。`reply.begin`复用11请求键、身份与unknown保护，保存真实触发发言和历史覆盖依据。历史not_started/running拒绝生成，incomplete必须本次明确接受；警告进入冻结输入与输出依据。任何重开、选稿、编辑和回看均不发送模型请求。

`contracts.ts` 的 `ReplyKnowledgeReader.read/requireCurrent` 是08/09消费者接点：两者均在当前SQLite短事务调用；输入由宿主注册，HTTP不能提供正文、版本资格、SQL或adapter。`ReplyKnowledgeItem` 固定真实版本、本人／联系人范围、资格、发布集合及精确 `capture_record.id` 来源。正式写者负责核验精确版本及publication成员；本票再核验范围、来源与解释修订。未安装正式消费者时只返回空集合，不能把07提取原稿当成已采纳记忆。未确认候选有明确标注。13本轮暂缓，不读取或保存长期表达偏好。

`reply_candidate_context` 冻结本人／联系人memory/document修订，即使本次没有选择材料也保留。`reply_candidate_input` 是在11现有输入类型之外增量安装的真实候选输入快照；不重建或修改已发布的7版context表，也不伪造08/09父表。每项知识版本由消费者同事务验证，正文与全部来源不可改写。`reply_execution_input` 将这些快照绑定到真实model_request事件；`event_source_planned` 新迁移保留原三分支并追加这一真实输入分支。展示依据仅引用这次call的实际输入，不能替代完整来源闭包。

候选执行每次重建独立受管DSH副本，以避免未选择的旧候选通过SDK历史进入下一请求。只有同讨论的真实selection可以显式携入；携入固定正文版本及原始输入来源。Skill仍由14的官方provider读取，assertCurrent/recordSelection/recordInput及写事务requireSkillRun沿11真实合同，不以selected冒充loaded，不改变原目录。

`replyCandidateDeletionDomain` 必须列入requiredDomains，并在discussion_calls前释放候选FK；其余原有域顺序保持。来源闭包由11收集，增量纳入知识/选稿完整来源及后续显式携入请求。fence立即撤下候选正文与依据、不可逆清除版本资格；05排空持有者后清实际输入、选择、版本、调用追踪及11完整受管文件。候选域自身没有文件目标，不能声称只删本域即完成删除。

当前合成证据：`test/sqlite-reply-candidates.test.mjs`，外部渠道与供应商为明确本机合成边界，SQLite/历史服务/官方DSH/provider/arbiter/文件均为真实实现。正式08/09输出组合、认证HTTP、实际页面与真实模型质量按票单独记录；本说明不表示这些验收已完成。
