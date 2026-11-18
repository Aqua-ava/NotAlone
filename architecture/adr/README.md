# 架构决策目录

仅在查找具体决策、核验来源或复审取舍时使用本目录。当前开发先从[架构阅读入口](../README.md)定位现行规格；这里的标题与编号不表示全部条款仍有效，也不证明实现或验收完成。

阅读 ADR 时先看顶部替代范围，再读取与任务有关的条款。部分替代的 ADR 保留原路径及历史正文，仍有效的约束由现行规格承接。

同号 ADR-074 有两份，引用时附标题与完整链接，不能只凭编号判断。

`superseded/` 存放已被后续决定整体替代（状态为“已替代”）、默认运行路径已不再使用（状态为“已退役”），或其仍有效条款已收拢进“现行合并 ADR”（状态为“已合并”，顶部写明并入的 ADR 编号）的 ADR，仅供追溯；它们描述的机制在现行代码中不再作为默认行为，不得当作新增要求。

## 决策文件

- [ADR-001：Mac 微信前台会话增量同步](001-macos-wechat-active-session-sync.md)
- [ADR-002：关系提取与全自动采纳](002-relationship-extraction-and-tiered-adoption.md)
- [ADR-003：Mac 同步连续性与用户补录](003-macos-sync-continuity-and-backfill.md)
- [ADR-004：用户自行导出的微信单联系人历史文件](004-user-managed-wechat-history-export.md)
- [ADR-005：可解释检索与联系人知识视图](005-explainable-retrieval-and-contact-knowledge-view.md)
- [ADR-006：Agent 编排与检索框架边界](006-agent-orchestration-and-retrieval-frameworks.md)（框架选型已替代；其余有效范围见文首）
- [ADR-007：后台任务步骤与 Worker 执行边界](007-background-task-steps-and-worker.md)
- [ADR-008：联系人身份与渠道身份分离](008-separate-contact-and-channel-identity.md)
- [ADR-009：使用 LangChain create_agent 实现有界候选回复循环](009-langchain-create-agent-bounded-reply-loop.md)（框架选型已替代；其余有效范围见文首）
- [ADR-010：使用 Deep Agents SkillsMiddleware 加载回复 Skill](010-deep-agents-skills-middleware.md)（框架选型已替代；其余有效范围见文首）
- [ADR-011：关系记忆自动管理与主题目录渐进加载](011-automatic-relationship-memory-index.md)
- [ADR-012：候选回复流程与内部模块边界](012-reply-module-boundaries.md)
- [ADR-013：Owner 渠道身份与首次导入初始化](013-owner-channel-identity-initialization.md)
- [ADR-014：历史导入的记忆提取窗口与异步任务](014-historical-memory-extraction-window.md)
- [ADR-015：后台任务与联系人记忆目录生命周期](015-background-task-and-memory-index-lifecycle.md)
- [ADR-016：用本地微信 CLI 读取消息正文，OCR 只定位当前会话](016-local-wechat-cli-observation.md)
- [ADR-017：优先用选中会话元数据匹配当前微信会话](017-selected-session-metadata-matching.md)
- [ADR-018：Worker 启动命令当前全局串行](018-worker-command-global-serialization.md)
- [ADR-019：回复 Skill 的受控辅助资源](019-controlled-reply-skill-resources.md)
- [ADR-020：常驻本地后端服务与事件驱动前台同步](020-local-backend-service-and-event-driven-sync.md)
- [ADR-021：源码分发与双层首次配置](021-source-distribution-and-first-run-setup.md)
- [ADR-022：前台同步人工验证的独立控制面](022-foreground-sync-verification-control-surface.md)
- [ADR-023：全局 CLI 增量同步与前台 OCR 定位分离](023-global-cli-sync-and-ocr-foreground-locator.md)
- [ADR-024：关系记忆风险门槛与版本化采纳](024-memory-adoption-risk-gate-and-versioning.md)
- [ADR-025：CLI 后台同步自动补齐可检测缺口](025-cli-background-sync-gap-backfill.md)
- [ADR-026：语用解释先于关系记忆采纳](superseded/026-pragmatic-interpretation-before-memory-adoption.md)
- [ADR-027：记忆准确率评测门槛与待确认候选的参考边界](superseded/027-memory-accuracy-evaluation-gate.md)
- [ADR-028：记忆召回第一期采用确定性中文词法评分](superseded/028-lexical-memory-recall-phase-1.md)（已合并入ADR-195）
- [ADR-029：提取失败的分类计数与批次跳过恢复](029-extraction-failure-recovery.md)
- [ADR-030：已确认联系人的后台同步与首次手动选择](030-confirmed-contact-background-sync-consent.md)
- [ADR-031：来源删除保留不含正文的调用记录](031-source-deletion-retains-minimal-ledger.md)
- [ADR-032：审计基线与实际迁移账本分开](032-audited-legacy-schema-baseline.md)
- [ADR-033：记忆采纳前核验来源语义支持](033-source-semantic-verification-before-adoption.md)
- [ADR-034：显式失败任务恢复按原任务领取](034-explicit-failed-task-recovery-selection.md)
- [ADR-035：待确认候选作为强制标注的未确认参考进入回复](superseded/035-pending-candidate-unconfirmed-reply-reference.md)（已合并入ADR-195）
- [ADR-036：按维度放行自动采纳](superseded/036-per-dimension-adoption-release.md)
- [ADR-037：默认保存记忆提取的完整过程](037-complete-memory-extraction-trace.md)
- [ADR-038：导入触发原记忆任务并让前台回复优先](038-import-triggered-memory-work-and-reply-priority.md)
- [ADR-039：退役 Swift 主界面，重新设计共享前端](039-retire-swift-main-interface.md)
- [ADR-040：Electron 双窗口桌面宿主](040-electron-dual-window-host.md)
- [ADR-041：观察提交后唤醒联系人记忆任务](041-observation-triggered-memory-work.md)
- [ADR-042：持续助手会话与单次运行上下文分界](042-assistant-session-context-boundary.md)
- [ADR-043：聊天场景与有界方向探索](043-conversation-scenarios-and-direction-exploration.md)
- [ADR-044：主动保存的表达样本独立于助手会话留存](superseded/044-explicit-style-sample-retention.md)
- [ADR-045：ECNU 回复输入预算采用明确标注的估算与余量](045-explicit-estimated-ecnu-input-budget.md)
- [ADR-046：维度依据绑定当前来源，第四门采用合取](superseded/046-source-bound-dimension-evidence.md)
- [ADR-047：同次来源核验的有界提案与版本二语义依据](superseded/047-bounded-source-semantic-proof.md)
- [ADR-048：记忆演进与自动 Skill 的受控生命周期](048-memory-skill-evolution-lifecycle.md)
- [ADR-049：前台微信窗口自动布局与局部名称 OCR](049-automatic-foreground-window-layout.md)
- [ADR-050：持续单帧前台定位与联系人内容、任务归属](050-continuous-single-frame-contact-follow.md)
- [ADR-051：原文分句结构提取与确定性候选编译](051-grounded-memory-extraction.md)
- [ADR-052：顶部名称 OCR 接入正式前台定位](052-header-ocr-foreground-locator.md)
- [ADR-053：前台定位刷新与稳定结果展示](053-stable-foreground-refresh.md)
- [ADR-054：前台采集上下文变化后的可靠绑定恢复](054-foreground-context-recovery.md)
- [ADR-055：群聊前台暂停与私聊恢复](055-group-foreground-pause.md)
- [ADR-056：前台观察繁忙恢复与有限执行预算](056-foreground-busy-and-observation-budget.md)
- [ADR-057：顶部局部变化提示优先触发正式前台观察](057-header-change-triggered-foreground-observation.md)
- [ADR-058：显式受控歧义标签与程序固定解释](superseded/058-controlled-ambiguity-labels.md)
- [ADR-059：显式未知类型与完整日历月的离线编译](superseded/059-closed-unknown-kinds-and-calendar-month.md)
- [ADR-060：作者到家原事件的有限引句表示](superseded/060-author-arrival-quote-representation.md)
- [ADR-061：独立本机 App 的首启与兼容更新](061-standalone-local-app-onboarding-and-updates.md)
- [ADR-062：官方 DeepSeek Flash 回复采用完整请求估算](062-official-deepseek-reply-input-budget.md)
- [ADR-063：指定任务的有限运行依据与正文来源依赖](063-bounded-runtime-evidence-and-source-dependencies.md)
- [ADR-064：E2有限负向指代说明保持未知](superseded/064-bounded-negative-reference-notes.md)
- [ADR-065：独立 App 首版先交付手动输入路径](065-manual-input-standalone-first-release.md)
- [ADR-066：沿用现有数据库并原地补齐结构](066-in-place-schema-updates-and-database-reuse.md)
- [ADR-067：场景文档与长期画像的分层加载](067-layered-scenario-and-profile-context.md)
- [ADR-068：生成候选后由用户选择，不追加模型复核](068-direct-reply-candidates-with-user-selection.md)
- [ADR-069：按场景直接生成记忆与逐项发布](069-direct-scene-memory-and-isolated-publication.md)
- [ADR-070：默认自动维护记忆并退役旧资料升级](070-automatic-memory-maintenance.md)
- [ADR-071：区分错误纠正与状态变化的历史生成资格](071-memory-retirement-and-generation-eligibility.md)
- [ADR-072：个人主题与画像允许有据推断，排除行动指导](072-personal-memory-insights-without-action-guidance.md)
- [ADR-073：前台观察与后台同步独立执行](073-foreground-observation-independent-of-background-sync.md)
- [ADR-074：当前对话自动判断并加载回复 Skill](074-automatic-conversation-skill-loading.md)
- [ADR-074：参考腾讯源码自行实现自动记忆](074-tencent-reference-python-memory.md)
- [ADR-075：孤立尾部表情的独立文字证据](075-isolated-emoji-tail-text-evidence.md)
- [ADR-076：结合完整会话名单核验标题 OCR](076-session-list-assisted-name-matching.md)
- [ADR-077：完整名称命中优先于编辑近邻](077-exact-session-name-before-edit-neighbors.md)
- [ADR-078：按请求复用原生前台观察进程](078-request-driven-native-observation-worker.md)
- [ADR-079：统一表达工作区与直接建议候选](079-unified-expression-workspace.md)
- [ADR-080：统一记忆列表与失效记忆禁用](080-unified-memory-list-and-retired-exclusion.md)
- [ADR-081：来源锚点、日期精度与条件性记忆](081-source-grounded-memory-time-and-conditions.md)
- [ADR-082：退役主动收藏表达样本](082-retire-explicit-style-samples.md)
- [ADR-083：遗漏消息自动恢复与简化同步界面](083-automatic-sync-recovery.md)
- [ADR-084：顶部联系人搜索与独立创建入口退役](084-topbar-contact-search.md)
- [ADR-085：以来源核验统一默认自动采纳边界](085-source-verified-automatic-adoption.md)
- [ADR-086：按来源含义采纳记忆，不设统一重复次数门槛](086-source-meaning-without-repetition-threshold.md)
- [ADR-087：新联系人只从微信会话确认加入](087-wechat-confirmed-contact-onboarding.md)
- [ADR-088：一秒作为正常联系人切换的优化目标](088-normal-switch-one-second-optimization-target.md)
- [ADR-089：一次授权同步全部微信私聊](089-all-private-wechat-sync-scope.md)
- [ADR-090：回复运行时按需补查受控历史](superseded/090-bounded-runtime-history-retrieval.md)（已合并入ADR-195）
- [ADR-091：不增加运行计划和自动过程摘要](091-retire-runtime-todos-and-auto-summary.md)
- [ADR-092：时间、日历和网络搜索工具保留为未来可选方向](092-defer-time-calendar-web-tools.md)
- [ADR-093：沿用现有 Skill 导入限制与整轮输入预算](093-retain-current-skill-resource-budget.md)
- [ADR-094：按删除范围保留或清除最小调用记录](094-ledger-erasure-by-deletion-scope.md)
- [ADR-095：首次连接微信与一次账号范围授权](095-first-wechat-connection-and-account-grant.md)
- [ADR-096：目录保存回复 Skill，数据库只管理业务状态](096-directory-backed-reply-skills.md)
- [ADR-097：维度门运维回退保留来源核验](superseded/097-dimension-gate-rollback-keeps-source-verification.md)
- [ADR-098：Skill 数据库只保留业务状态](098-skill-business-state-only.md)
- [ADR-099：提取任务内的批次流水线](099-parallel-batch-extraction.md)
- [ADR-100：授权私聊首次完整历史同步](100-authorized-private-history-sync.md)
- [ADR-101：本机 App 完整首用与资料生命周期](101-local-app-first-use-lifecycle.md)
- [ADR-102：以精简 DSH 和 TypeScript 统一后端](102-dsh-typescript-backend-migration.md)
- [ADR-103：统一业务后台任务的查看、停止与恢复](103-unified-background-task-management.md)
- [ADR-104：记忆生成逻辑按领域模块维护](104-tencent-source-memory-engine.md)
- [ADR-105：以当前有效绑定观察恢复前台确认](105-fresh-verified-foreground-recovery.md)
- [ADR-106：持久助手会话、空闲分段与恢复职责](106-persistent-assistant-conversations.md)
- [ADR-107：统一记忆处理入口与安全自动恢复](107-unified-memory-processing-lifecycle.md)
- [ADR-108：隔离无法核验的存量记忆任务](108-isolate-unresolved-legacy-memory-processing.md)
- [ADR-109：受控 SQLite 底座与分票切换](109-controlled-sqlite-storage-foundation.md)
- [ADR-110：SQLite 联系人身份与逐人读取授权](110-selected-sqlite-contact-read-grants.md)
- [ADR-113：SQLite 私聊历史、消息身份与实际来源](113-sqlite-private-history-source-contract.md)
- [ADR-117：SQLite 记忆候选、决定与版本](117-sqlite-memory-decisions-and-versions.md)
- [ADR-118：SQLite 场景资料与长期概览的完整发布](118-sqlite-memory-documents-and-publication.md)
- [ADR-121：SQLite 候选版本、实际输入与选稿](121-sqlite-reply-candidates-and-basis.md)
- [ADR-125：图片视频字节转换与实际解码验证](125-image-video-byte-decoding-and-validation.md)
- [ADR-126：受管语音原件与本地SILK转换](126-managed-voice-local-silk-conversion.md)
- [ADR-127：SQLite 私聊历史正常重启后从头重扫](127-sqlite-history-normal-use-restart-rescan.md)
- [ADR-128：微信消息去重保存与撤回状态](128-deduplicated-wechat-message-storage.md)
- [ADR-129：DSH 回复 Skill 的受控发现与启用](129-controlled-dsh-reply-skill-discovery.md)
- [ADR-130：同账号本机来源变化后的明确重新关联](130-explicit-wechat-source-reconfirmation.md)
- [ADR-131：联系人确认后使用当前可用资料生成](131-available-context-without-history-wait.md)
- [ADR-132：按会话名称关联已有联系人](132-existing-contact-name-matching.md)
- [ADR-133：按变化页持续同步与持久检查点](133-page-delta-private-history-sync.md)
- [ADR-135：Skill 默认启用与中文场景管理](135-default-enabled-localized-skill-library.md)
- [ADR-136：回复生成按需组合多个 Skill](136-multi-skill-reply-composition.md)
- [ADR-137：授权会话同步中的原图保存](137-original-image-authorized-sync.md)
- [ADR-138：聊天图片原图提取与占位替换](138-chat-image-original-extraction-and-placeholder.md)
- [ADR-139：引用回复同步与历史补齐](139-quoted-reply-sync-and-history-enrichment.md)
- [ADR-140：聊天图片取消原图证明门槛](140-source-verified-viewable-chat-images.md)
- [ADR-141：引用回复随正常消息同步读取](141-inline-quoted-reply-sync.md)
- [ADR-142：首次连接后先选择联系人，再确认开启同步](142-first-connection-contact-selection.md)
- [ADR-143：混合记忆处理调度](143-hybrid-memory-processing-schedule.md)
- [ADR-144：保留旧资料的来源重新认证](superseded/144-preserved-history-source-recertification.md)（流程已由ADR-177替代，保留合法旧资料与必要删除事实）
- [ADR-145：记忆处理卡跟随当前联系人](145-contact-scoped-memory-processing-view.md)
- [ADR-146：AI 服务地址与密钥由用户填写](146-editable-deepseek-endpoint.md)
- [ADR-147：OpenCode Go 的模型环境配置](147-opencode-go-model-configuration.md)
- [ADR-148：代码策略更新后的未完成记忆任务恢复](148-memory-policy-recovery.md)
- [ADR-149：内容级候选拒绝不构成记忆处理失败](149-content-rejection-is-not-failure.md)
- [ADR-150：发生时间标注降级为可选信息](150-optional-event-time.md)
- [ADR-151：单个微信读取进程串行切换联系人](151-shared-wechat-cli-process.md)
- [ADR-152：历史与增量记忆分开自动处理](152-history-and-incremental-memory-processing.md)
- [ADR-153：图文共同参与记忆处理](153-joint-text-image-memory-input.md)
- [ADR-154：按微信资源来源记录图片版本](154-source-grounded-image-versions.md)
- [ADR-155：图片资源角色展示与缩略图复查](155-image-variant-display-and-thumbnail-refresh.md)
- [ADR-156：授权范围内自动补查全部图片](156-automatic-image-reconciliation.md)
- [ADR-157：Skill 业务身份与可迁移物理定位分离](157-portable-skill-directory-identity.md)
- [ADR-158：显式选择联系人后继续前台跟随](158-contact-selection-keeps-foreground-follow.md)
- [ADR-159：前台联系人识别独立读取通道](159-foreground-read-channel-isolation.md)
- [ADR-160：助手回看与 Skill 核验分离执行队列](160-assistant-read-and-skill-worker-isolation.md)
- [ADR-161：旧读取器来源的有界抑制映射](161-proved-legacy-source-suppression-mapping.md)（创建／认证传承流程已由ADR-177替代；既有有效删除等价范围仍保留）
- [ADR-162：本机回复资料与独立模型并发](162-local-reply-context-and-independent-model-lanes.md)
- [ADR-163：退役未接入 SQLite 的旧回复流程](163-retire-disconnected-reply-workflows.md)
- [ADR-164：大历史分段恢复与联系人公平轮转](164-resumable-history-slices.md)
- [ADR-165：退役逐条消息排除，固定关系背景自动上下文](165-remove-message-exclusion.md)
- [ADR-166：记忆自动处理总开关，默认关闭](166-memory-auto-processing-switch.md)
- [ADR-167：记忆页在读取授权暂时不可用时继续显示已保存记忆](167-memory-page-saved-source-display.md)
- [ADR-168：受管文件身份不含系统设备号](168-managed-file-identity-without-device.md)
- [ADR-169：记忆只带入确认不是缩略图的图片](169-memory-uses-confirmed-non-thumbnail-images.md)
- [ADR-170：不保存缩略图，取消原图分类机制](170-no-thumbnail-storage-and-no-original-classification.md)
- [ADR-171：同一张图有标准图和高清图时取一张保存，不再比较内容](171-image-pick-standard-over-high-definition.md)
- [ADR-172：JPEG 结束标记后允许少量尾随，WXGF 支持彩色加透明度双帧](172-jpeg-trailing-bytes-and-wxgf-alpha-frames.md)
- [ADR-173：开发者批量来源重新认证](superseded/173-developer-batch-source-recertification.md)（已被ADR-177替代，原开发者入口退役）
- [ADR-174：对齐腾讯方案——不确定性降级而非拦截候选](174-align-tencent-uncertainty-degrade-not-intercept.md)——部分被 ADR-184 替代
- [ADR-175：修复同步通过后清理被取代绑定下无派生引用的旧副本](superseded/175-clean-superseded-binding-copies.md)（已被ADR-177替代，一次性存量清理完成后退役流程；保留引用保护与必要删除事实）

- [ADR-176：核对来源后原地续读，不旋转绑定](176-in-place-source-recovery.md)——保留原地来源核对；守卫生命周期及暂留旧流程由ADR-177收敛。

- [ADR-177：退役重新认证与副本清理流程，保留最小删除等价事实](177-retire-source-recertification-and-cleanup.md)——来源守卫仅保护本轮独占读取，删除旧请求／批量面板和清理流程，迁移保留必要旧来源删除保护。

- [ADR-178：按联系人分组限定可用的回复 Skill](178-contact-skill-groups.md)——用户自定义分组绑定 Skill，联系人至多归入一组，未分组默认不使用 Skill；局部修订 ADR-135／136。

- [ADR-179：记忆图片在内存规范化并保留原图依据](179-memory-image-input-normalization.md)

- [ADR-180：图片输入有界恢复、单项隔离与运行退休](180-memory-image-recovery-isolation-and-run-retirement.md)

- [ADR-181：L3 逐条核验与合格条目发布](181-l3-item-verification-and-partial-publication.md)
- [ADR-182：回复时联系人／本人记忆改用本机混合检索](superseded/182-reply-memory-hybrid-retrieval.md)（已合并入ADR-195）
- [ADR-183：回复模型调用结果未知时自动放弃，不锁定联系人](183-auto-abandon-unknown-reply-model-calls.md)——局部修订 ADR-121 的 unknown 阻断口径。
- [ADR-184：有来源支持的记忆变化自动更新与合并](184-source-grounded-memory-update-and-merge.md)——局部替代 ADR-174／081 的动作与变化拦截限制，保留来源和人工保护。

- [ADR-185：先读近期语境，再按需检索记忆和历史](superseded/185-on-demand-reply-memory-and-history-search.md)——局部替代固定预检索，保留 DSH 官方装配、联系人范围、来源与有界读取。（已合并入ADR-195）

- [ADR-186：按需搜索当前联系人全部获准历史](superseded/186-full-contact-history-search.md)——取消五百条候选窗口，保留 DSH 官方工具与返回量、耗时、次数上限。（已合并入ADR-195）

- [ADR-187：退役表达工作区最近聊天区块及专用读取链](187-retire-workspace-recent-chat.md)——保留自动背景和候选依据，移除区块与候选列表的额外聊天读取。

- [ADR-188：想法、语气和要求统一为主输入](188-unify-workspace-writing-input.md)——移除独立设置及新请求字段，保留历史快照只读回看。

- [ADR-189：分别手动配置回复与记忆的模型参数](189-editable-model-thinking-and-temperature.md)——开放独立思考档位与温度，复用受控配置重载和唯一 DSH provider。

- [ADR-190：L1 与 L0 统一采用腾讯式本机混合检索](superseded/190-tencent-style-local-hybrid-retrieval.md)——共享 BM25、向量与 RRF，正文表示增量维护并纳入删除。（已合并入ADR-195）

- [ADR-191：收敛回复检索合同并退役未使用适配](superseded/191-reply-retrieval-contract-simplification.md)——强制按需读者与已有排名，退役旧词法／未确认候选选择接口，保留历史材料和删除合同。（已合并入ADR-195）

- [ADR-192：前台定位仅保留名称观察与已有联系人关联](192-retire-foreground-observation-compatibility.md)——退役旧双区域协议及前台再次确认写证明链，保留名称质量、手选和授权边界。

- [ADR-193：回复 Skill 统一按需目录并退役显式预加载](193-retire-explicit-reply-skill-preload.md)——新请求拒绝显式选包，保留历史材料及删除约束。

- [ADR-194：集中运行事实与回复准备职责](194-single-runtime-facts-and-reply-preparation.md)——统一在途及尝试登记，收敛近期聊天读取，退役新请求的旧历史确认参数。

- [ADR-195：回复检索现行合并决定](195-reply-retrieval-consolidated.md)——合并 ADR-028／035／090／182／185／186／190／191：按需 BM25＋向量＋RRF 检索、全部获准历史、独立额度、未确认候选不进入新回复；原条目归档于 superseded/。
