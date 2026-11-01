# NotAlone 架构文档

> 当前运行状态（2026-10-30）：SQLite 已成为 TypeScript 后台默认业务存储；受控实例、迁移、联系人、历史、记忆、回复与删除实现见[SQLite 底座 ADR](adr/109-controlled-sqlite-storage-foundation.md)和[切换验收](../docs/verification/20-sqlite-cutover-and-legacy-cleanup.md)。本地 PostgreSQL 旧实现和数据已退役；其它历史架构决策保留原意，不代表当前运行入口。

> 2026-10-26 助手会话决定：[ADR-106](adr/106-persistent-assistant-conversations.md)已采纳每位联系人独立的持久会话、空闲 12 小时分段和旧会话明确继续；数据库作为可见业务历史主记录，DSH 文件保存可恢复执行记录。新策略、持久化与删除链已实现并接入正常开发入口，局部修订 ADR-042／102，不改变已有来源与输入预算边界。隔离合成、实际热更新、性能与有界模型样例的结论及限制见 ADR-106，不据此宣称整体性能或质量提升。

> 2026-10-26 记忆实现方向：[ADR-104](adr/104-tencent-source-memory-engine.md)中的生成与提示构建直接归入本地记忆模块，统一使用业务协议。合成检查与真实模型、桌面质量分别核验。

> 2026-10-26 后端状态：[ADR-102](adr/102-dsh-typescript-backend-migration.md)的当前产品入口已切换为 DSH 与 TypeScript，Python 后台与历史测试退出当前工作树；旧 PostgreSQL 数据和迁移 SQL 后续已清理，仍在使用的合成夹具已归入 TypeScript 后台。历史对照通过固定 Git 树恢复，入口见[后台说明](../backend-ts/README.md)。这不代表全部等价或发行验收通过，实际证据与未测项见[执行交接](../.scratch/dsh-ts-migration/execution.md)。

> 联系人首用决定：[ADR-087](adr/087-wechat-confirmed-contact-onboarding.md)保留真实微信来源建联与导入只补充已有联系人的规则；[ADR-089](adr/089-all-private-wechat-sync-scope.md)新增当前账号全部私聊的一次授权，包括以后新增会话。[ADR-095](adr/095-first-wechat-connection-and-account-grant.md)补充已有可用工具的首次账号连接与一次授权；[ADR-100](adr/100-authorized-private-history-sync.md)进一步要求每个授权私聊首次同步本机可读的全部既有文字，再持续增量。未配置机器的工具准备及新用户独立交付验收仍未完成。旧创建接口退役尚待完成；历史同步目标与实现边界见[规格](../.scratch/authorized-private-history-sync/spec.md)。

> 2026-10-22 提取并发：[ADR-099](adr/099-parallel-batch-extraction.md)允许同一提取任务内按批次流水线并行模型调用，采纳、写入与水位仍按批序串行；规格见[批次流水线](../.scratch/parallel-batch-extraction/spec.md)；已实现，真实验证边界见 ADR-099 的验证记录。

> 2026-10-21 设计审查：同号 ADR-074 有两份：引用时必须附“腾讯记忆”或“自动 Skill”标题及完整文件链接，不能仅凭编号推断替代。额外记忆人工门已由用户确认并通过 [ADR-085](adr/085-source-verified-automatic-adoption.md) 收敛；Runtime 按需检索已由 [ADR-090](adr/090-bounded-runtime-history-retrieval.md)确认受控只读边界；运行计划和自动过程摘要已按 [ADR-091](adr/091-retire-runtime-todos-and-auto-summary.md)取消强制接入要求；时间／日历／网络工具已按 [ADR-092](adr/092-defer-time-calendar-web-tools.md)改为未来可选方向。

> 状态：已建立。本目录区分现行约束、设计草案与 ADR；文档不代表对应功能已经实现。

## 文档分层

| 位置 | 唯一职责 |
| --- | --- |
| [`CONTEXT.md`](../CONTEXT.md) | 统一领域词汇，只定义概念。 |
| [`current/`](current/) | 已采纳、当前实现必须遵守的规格。 |
| [`drafts/`](drafts/) | 尚未全部确认或实现的设计，不作为现行约束。 |
| [`drafts/archive/`](drafts/archive/) | 已收束或已转为历史参考的设计，只供追溯，不是设计入口。 |
| [`adr/`](adr/) | 难以逆转且存在真实取舍的架构决策及原因。 |
| [`.scratch/`](../.scratch/) | 功能规格和可执行任务，不在架构文档中积累待办。 |

已完成的评审过程不保留为当前架构文档；已收束或完成使命的草案移入 [`drafts/archive/`](drafts/archive/) 供追溯，不作为设计入口，Git 历史负责保存旧版本。实际行为以代码和测试为准，不能用架构文档证明功能已经实现。

## 按任务阅读

1. 先读根目录 [`CONTEXT.md`](../CONTEXT.md)，使用统一领域语言。
2. 按任务读取一份或多份现行规格：[`domain-data.md`](current/domain-data.md)、[`core-flows.md`](current/core-flows.md)、[`privacy-deletion.md`](current/privacy-deletion.md)、[`skill-library.md`](current/skill-library.md)。涉及记忆提取溯源时，再读 [`memory-extraction-trace.md`](current/memory-extraction-trace.md)；全过程后端与 React 查看入口已实现并经合成验证，最终原生 App/渠道验收另按原任务推进。
3. 涉及回复运行时或真实表达质量时，读取对应草案：[`agent-runtime.md`](drafts/agent-runtime.md)、[`authentic-expression.md`](drafts/authentic-expression.md)。
4. 当现行规格或草案引用 ADR 时，再读取对应决策；复审既有决定时必须新增 ADR 修订或替代，不能覆盖历史原因。

聊天辅助产品讨论分别记录在[聊天回复策略草图](drafts/conversation-reply-strategy.md)和[持续会话与上下文管理草图](drafts/assistant-session-context.md)：前者讨论回应与主动联系两条路径，后者从 Q1 独立记录助手会话连续性及新开边界，均未替代现行规格。

DSH 与业务 Skill 接入的职责和受控文件读取实验见 [DSH Skill 接入草案](drafts/dsh-skill-integration.md)；自动学习规则留待后续讨论。

L2 场景文档与 L3 长期画像的[联合方案](drafts/layered-relationship-memory.md)已于 2026-10-17 整体确认，并整理为[正式规格](../.scratch/layered-relationship-memory/spec.md)；[11项拆分](../.scratch/layered-relationship-memory/ticket-proposal.md)已获认可并逐张发布，实际状态见[任务索引](../.scratch/layered-relationship-memory/planning.md)，现按真实依赖分票实现。加载方向由 ADR-067 局部修订；工程实现状态、真实模型质量与自动使用资格分别核验。

记忆持续更新、纠错、概览、回复检索及自动 Skill 学习等 8 个完整功能，已从[草图](drafts/memory-skill-evolution.md)整理为[正式规格](../.scratch/memory-skill-evolution/spec.md)；[15项拆分](../.scratch/memory-skill-evolution/ticket-proposal.md)已确认并逐张发布，实际进度见[任务索引](../.scratch/memory-skill-evolution/planning.md)。该轮 DSH 选型曾搁置；后续迁移已由ADR-102实施为TypeScript／DSH；联系人／本人概览服务及回复检索已接入正式后端与回复流程，见[后端装配](../backend-ts/src/sqlite-host-plugin.ts)和[回复服务装配](../backend-ts/src/reply/sqlite/runtime.ts)；这不表示全部 8 项功能、真实模型质量或实际 App 验收均已完成，其余状态按对应任务核验。

## ADR 索引

1. [ADR-001：Mac 微信前台会话同步](adr/001-macos-wechat-active-session-sync.md)
2. [ADR-002：关系提取与全自动采纳](adr/002-relationship-extraction-and-tiered-adoption.md)
3. [ADR-003：Mac 同步连续性与用户补录](adr/003-macos-sync-continuity-and-backfill.md)
4. [ADR-004：用户自行导出的微信单联系人历史文件](adr/004-user-managed-wechat-history-export.md)
5. [ADR-005：可解释检索与联系人知识视图](adr/005-explainable-retrieval-and-contact-knowledge-view.md)
6. [ADR-006：Agent 编排与检索框架边界](adr/006-agent-orchestration-and-retrieval-frameworks.md)
7. [ADR-007：后台任务步骤与 Worker 执行边界](adr/007-background-task-steps-and-worker.md)
8. [ADR-008：联系人身份与渠道身份分离](adr/008-separate-contact-and-channel-identity.md)
9. [ADR-009：使用 LangChain create_agent 实现有界候选回复循环](adr/009-langchain-create-agent-bounded-reply-loop.md)
10. [ADR-010：使用 Deep Agents SkillsMiddleware 加载回复 Skill](adr/010-deep-agents-skills-middleware.md)
11. [ADR-011：关系记忆自动管理与主题目录渐进加载](adr/011-automatic-relationship-memory-index.md)
12. [ADR-012：候选回复流程与内部模块边界](adr/012-reply-module-boundaries.md)
13. [ADR-013：Owner 渠道身份与首次导入初始化](adr/013-owner-channel-identity-initialization.md)
14. [ADR-014：历史导入的记忆提取窗口与异步任务](adr/014-historical-memory-extraction-window.md)
15. [ADR-015：后台任务与联系人记忆目录生命周期](adr/015-background-task-and-memory-index-lifecycle.md)
16. [ADR-016：用本地微信 CLI 读取消息正文，OCR 只定位当前会话](adr/016-local-wechat-cli-observation.md)
17. [ADR-017：优先用选中会话元数据匹配当前微信会话](adr/017-selected-session-metadata-matching.md)
18. [ADR-018：Worker 启动命令当前全局串行](adr/018-worker-command-global-serialization.md)
19. [ADR-019：回复 Skill 的受控辅助资源](adr/019-controlled-reply-skill-resources.md)
20. [ADR-020：常驻本地后端服务与事件驱动前台同步](adr/020-local-backend-service-and-event-driven-sync.md)
21. [ADR-021：源码分发与双层首次配置](adr/021-source-distribution-and-first-run-setup.md)
22. [ADR-022：前台同步人工验证的独立控制面](adr/022-foreground-sync-verification-control-surface.md)
23. [ADR-023：全局 CLI 增量同步与前台 OCR 定位分离](adr/023-global-cli-sync-and-ocr-foreground-locator.md)
24. [ADR-024：关系记忆风险门槛与版本化采纳](adr/024-memory-adoption-risk-gate-and-versioning.md)
25. [ADR-025：CLI 后台同步自动补齐可检测缺口](adr/025-cli-background-sync-gap-backfill.md)
26. [ADR-026：语用解释先于关系记忆采纳](adr/026-pragmatic-interpretation-before-memory-adoption.md)
27. [ADR-027：记忆准确率评测门槛与待确认候选的参考边界](adr/027-memory-accuracy-evaluation-gate.md)
28. [ADR-028：记忆召回第一期采用确定性中文词法评分](adr/028-lexical-memory-recall-phase-1.md)
29. [ADR-029：提取失败的分类计数与批次跳过恢复](adr/029-extraction-failure-recovery.md)
30. [ADR-030：已确认联系人的后台同步与首次手动选择](adr/030-confirmed-contact-background-sync-consent.md)

31. [ADR-031：来源删除保留不含正文的调用记录](adr/031-source-deletion-retains-minimal-ledger.md)
32. [ADR-032：审计基线与实际迁移账本分开](adr/032-audited-legacy-schema-baseline.md)
33. [ADR-033：记忆采纳前核验来源语义支持](adr/033-source-semantic-verification-before-adoption.md)
34. [ADR-034：显式失败任务恢复按原任务领取](adr/034-explicit-failed-task-recovery-selection.md)
35. [ADR-035：待确认候选作为强制标注的未确认参考进入回复](adr/035-pending-candidate-unconfirmed-reply-reference.md)
36. [ADR-036：按维度放行自动采纳](adr/036-per-dimension-adoption-release.md)
37. [ADR-037：默认保存记忆提取的完整过程](adr/037-complete-memory-extraction-trace.md)
38. [ADR-038：导入触发原记忆任务并让前台回复优先](adr/038-import-triggered-memory-work-and-reply-priority.md)
39. [ADR-039：退役 Swift 主界面，重新设计共享前端](adr/039-retire-swift-main-interface.md)

40. [ADR-040：Electron 双窗口桌面宿主](adr/040-electron-dual-window-host.md)
41. [ADR-041：观察提交后唤醒联系人记忆任务](adr/041-observation-triggered-memory-work.md)
42. [ADR-042：持续助手会话与单次运行上下文分界](adr/042-assistant-session-context-boundary.md)
43. [ADR-043：聊天场景与有界方向探索](adr/043-conversation-scenarios-and-direction-exploration.md)
44. [ADR-044：主动保存的表达样本独立于助手会话留存](adr/044-explicit-style-sample-retention.md)（历史，已由 ADR-082 整体替代）
45. [ADR-045：ECNU 回复输入预算采用明确标注的估算与余量](adr/045-explicit-estimated-ecnu-input-budget.md)
46. [ADR-046：维度依据绑定当前来源，第四门采用合取](adr/046-source-bound-dimension-evidence.md)
47. [ADR-047：同次来源核验的有界提案与版本二语义依据](adr/047-bounded-source-semantic-proof.md)
48. [ADR-048：记忆演进与自动 Skill 的受控生命周期](adr/048-memory-skill-evolution-lifecycle.md)
49. [ADR-049：前台微信窗口自动布局与局部名称 OCR](adr/049-automatic-foreground-window-layout.md)
50. [ADR-050：持续单帧前台定位与联系人内容、任务归属](adr/050-continuous-single-frame-contact-follow.md)

51. [ADR-051：原文分句结构提取与确定性候选编译](adr/051-grounded-memory-extraction.md)
52. [ADR-052：顶部名称 OCR 接入正式前台定位](adr/052-header-ocr-foreground-locator.md)
53. [ADR-053：前台定位刷新与稳定结果展示](adr/053-stable-foreground-refresh.md)
54. [ADR-054：前台采集上下文变化后的可靠绑定恢复](adr/054-foreground-context-recovery.md)
55. [ADR-055：群聊前台暂停与私聊恢复](adr/055-group-foreground-pause.md)
56. [ADR-056：前台观察繁忙恢复与有限执行预算](adr/056-foreground-busy-and-observation-budget.md)
57. [ADR-057：顶部局部变化提示优先触发正式前台观察](adr/057-header-change-triggered-foreground-observation.md)
58. [ADR-058：显式受控歧义标签与程序固定解释](adr/058-controlled-ambiguity-labels.md)
59. [ADR-059：显式未知类型与完整日历月的离线编译](adr/059-closed-unknown-kinds-and-calendar-month.md)
60. [ADR-060：作者到家原事件的有限引句表示](adr/060-author-arrival-quote-representation.md)
61. [ADR-061：独立本机 App 的首启与兼容更新](adr/061-standalone-local-app-onboarding-and-updates.md)
62. [ADR-062：官方 DeepSeek Flash 回复采用完整请求估算](adr/062-official-deepseek-reply-input-budget.md)
63. [ADR-063：指定任务的有限运行依据与正文来源依赖](adr/063-bounded-runtime-evidence-and-source-dependencies.md)
64. [ADR-064：E2有限负向指代说明保持未知](adr/064-bounded-negative-reference-notes.md)

65. [ADR-065：独立 App 首版先交付手动输入路径](adr/065-manual-input-standalone-first-release.md)
66. [ADR-066：沿用现有数据库并原地补齐结构](adr/066-in-place-schema-updates-and-database-reuse.md)
67. [ADR-067：场景文档与长期画像的分层加载](adr/067-layered-scenario-and-profile-context.md)
68. [ADR-068：生成候选后由用户选择，不追加模型复核](adr/068-direct-reply-candidates-with-user-selection.md)

70. [ADR-070：默认自动维护记忆并退役旧资料升级](adr/070-automatic-memory-maintenance.md)
71. [ADR-071：区分错误纠正与状态变化的历史生成资格](adr/071-memory-retirement-and-generation-eligibility.md)
72. [ADR-072：个人主题与画像允许有据推断，排除行动指导](adr/072-personal-memory-insights-without-action-guidance.md)
73. [ADR-073：前台观察与后台同步独立执行](adr/073-foreground-observation-independent-of-background-sync.md)
74. [ADR-074：参考腾讯源码自行实现自动记忆](adr/074-tencent-reference-python-memory.md)

74. [ADR-074：当前对话自动判断并加载回复 Skill](adr/074-automatic-conversation-skill-loading.md)
75. [ADR-075：孤立尾部表情的独立文字证据](adr/075-isolated-emoji-tail-text-evidence.md)
76. [ADR-076：结合完整会话名单核验标题 OCR](adr/076-session-list-assisted-name-matching.md)
77. [ADR-077：完整名称命中优先于编辑近邻](adr/077-exact-session-name-before-edit-neighbors.md)
78. [ADR-078：按请求复用原生前台观察进程](adr/078-request-driven-native-observation-worker.md)

79. [ADR-079：统一表达工作区与直接建议候选](adr/079-unified-expression-workspace.md)

80. [ADR-080：统一记忆列表与失效记忆禁用](adr/080-unified-memory-list-and-retired-exclusion.md)
81. [ADR-081：来源锚点、日期精度与条件性记忆](adr/081-source-grounded-memory-time-and-conditions.md)

82. [ADR-082：退役主动收藏表达样本](adr/082-retire-explicit-style-samples.md)

83. [ADR-083：遗漏消息自动恢复与简化同步界面](adr/083-automatic-sync-recovery.md)

84. [ADR-084：顶部联系人搜索与独立创建入口退役](adr/084-topbar-contact-search.md)
85. [ADR-085：以来源核验统一默认自动采纳边界](adr/085-source-verified-automatic-adoption.md)
86. [ADR-086：按来源含义采纳记忆，不设统一重复次数门槛](adr/086-source-meaning-without-repetition-threshold.md)
87. [ADR-087：新联系人只从微信会话确认加入](adr/087-wechat-confirmed-contact-onboarding.md)
88. [ADR-088：一秒作为正常联系人切换的优化目标](adr/088-normal-switch-one-second-optimization-target.md)

89. [ADR-089：一次授权同步全部微信私聊](adr/089-all-private-wechat-sync-scope.md)

90. [ADR-090：回复运行时按需补查受控历史](adr/090-bounded-runtime-history-retrieval.md)

91. [ADR-091：不增加运行计划和自动过程摘要](adr/091-retire-runtime-todos-and-auto-summary.md)

92. [ADR-092：时间、日历和网络搜索工具保留为未来可选方向](adr/092-defer-time-calendar-web-tools.md)

93. [ADR-093：沿用现有 Skill 导入限制与整轮输入预算](adr/093-retain-current-skill-resource-budget.md)

94. [ADR-094：按删除范围保留或清除最小调用记录](adr/094-ledger-erasure-by-deletion-scope.md)

95. [ADR-095：首次连接微信与一次账号范围授权](adr/095-first-wechat-connection-and-account-grant.md)

96. [ADR-096：目录保存回复 Skill，数据库只管理业务状态](adr/096-directory-backed-reply-skills.md)

97. [ADR-097：维度门运维回退保留来源核验](adr/097-dimension-gate-rollback-keeps-source-verification.md)

98. [ADR-098：Skill 数据库只保留业务状态](adr/098-skill-business-state-only.md)

99. [ADR-099：提取任务内的批次流水线](adr/099-parallel-batch-extraction.md)

100. [ADR-100：授权私聊首次完整历史同步](adr/100-authorized-private-history-sync.md)
101. [ADR-101：本机 App 完整首用与资料生命周期](adr/101-local-app-first-use-lifecycle.md)
102. [ADR-102：以精简 DSH 和 TypeScript 统一后端](adr/102-dsh-typescript-backend-migration.md)
103. [ADR-103：统一业务后台任务的查看、停止与恢复](adr/103-unified-background-task-management.md)
104. [ADR-104：记忆生成逻辑按领域模块维护](adr/104-tencent-source-memory-engine.md)
105. [ADR-105：以当前有效绑定观察恢复前台确认](adr/105-fresh-verified-foreground-recovery.md)
107. [ADR-107：统一记忆处理入口与安全自动恢复](adr/107-unified-memory-processing-lifecycle.md)
108. [ADR-108：隔离无法核验的存量记忆任务](adr/108-isolate-unresolved-legacy-memory-processing.md)

- [ADR-113：SQLite 私聊历史、消息身份与实际来源](adr/113-sqlite-private-history-source-contract.md)
- [ADR-127：SQLite 私聊历史正常重启后从头重扫](adr/127-sqlite-history-normal-use-restart-rescan.md)
- [ADR-133：按变化页持续同步与持久检查点](adr/133-page-delta-private-history-sync.md)
- [ADR-128：微信消息去重保存与撤回状态](adr/128-deduplicated-wechat-message-storage.md)

## 当前架构决策

- 微信消息去重与撤回保留按 [ADR-128](adr/128-deduplicated-wechat-message-storage.md)调整，修订 ADR-113 的重复捕获及撤回正文规则；设计已确认，实施、迁移和验收尚未完成。

- 完整本机首用及资料生命周期按 [ADR-101](adr/101-local-app-first-use-lifecycle.md)与[新票据](../.scratch/local-app-first-use/planning.md)落实：默认仅所选会话；联系人、SQLite 实例与本机资料按当前生命周期管理；完整独立交付仍待验收。

- 已授权微信私聊按 [ADR-100](adr/100-authorized-private-history-sync.md)在首次进入同步范围时读取本机当前可读的全部既有文字，再持续增量；仅所选和全部私聊使用同一规则。聊天历史属于消息层，关系提取是独立后台派生任务，不阻塞首次历史同步。该决定的规格票01–07已记录完成，票08真实微信验收未完成；不能据合成或分项结果宣称完整集成可用。
- 正常 App 重启后的同来源恢复按 [ADR-127](adr/127-sqlite-history-normal-use-restart-rescan.md)限定为账号、数据库文件及表实例身份精确一致；[ADR-133](adr/133-page-delta-private-history-sync.md)进一步改为变化页与已接受持久检查点，不再要求每次完整重扫，继续保留删除／排除边界。新路径实施和验收进行中，旧重扫验收不证明新路径可用。

- 主动收藏表达样本按 [ADR-082](adr/082-retire-explicit-style-samples.md)退役；删除独立样本库、入口和生成参考，清理遗留依赖及可重放副本。普通候选编辑复制与用户明确管理的长期表达偏好保留，历史样本验收不代表本次退役验证。

- 旧 Swift 主界面已按 ADR-039 退役；共享前端采用 TypeScript + React，由 ADR-040 的 Electron 双窗口宿主承载；已接通业务页面，完整原生验收仍未完成。当前代码为TypeScript／DSH后台与Mac原生探针；Python后端和旧框架已退役，原生能力继续复用；实际验证及跳过项见迁移25／26。
- 独立桌面版采用本机受管后台与 SQLite，联系人、消息、关系资料、任务和删除状态存于本机受控实例。结构初始化与升级由当前迁移注册表管理，新实例按当前生命周期创建；新装交付与最终验收状态分别核验。云端工程已于2026-10-29取消。
- 新联系人按 ADR-087／089 从真实微信会话加入，支持逐会话确认或全部私聊范围授权；ADR-095 补充已有可用外置工具的首次账号连接，无需先导入历史。已有联系人可手动表达，顶部选择器是唯一搜索入口；未配置机器的工具初始化与独立渠道验收仍未完成，ADR-065 的空目录无需微信首用承诺已被替代。资料更新按 ADR-066 原地补齐，历史副本删除清理、隐私与人工发送要求保持。
- 数据隔离键为 `owner_id + contact_id`；`contact_id` 由 NotAlone 创建，昵称、备注和微信来源标识不能替代它。
- 文字是统一的检索与生成表示；前台 display name OCR、本地微信 CLI、截图和语音都是输入适配器。
- Mac 前台 OCR 按 ADR-052 仅识别顶部 display name，再按 ADR-076／132 结合有界全类型会话元数据、唯一已知私聊及已有稳定绑定匹配联系人；CLI 独立同步用户主动选择并确认的联系人及我方文字增量，首次不预选会话。CLI 的外部会话标识不能替代 `contact_id`，同步范围与停止/恢复规则见 ADR-030。
- 持续前台定位按 ADR-050 采用每轮单帧，进入助手或其他 App 后暂停；一个助手窗口按联系人恢复输入和编辑，切换不取消原生成。约束见[正式规格](../.scratch/foreground-contact-follow/spec.md)，实施进度统一见[任务索引](../.scratch/foreground-contact-follow/planning.md)，验证范围与剩余缺口见各任务的结果记录；任务关闭不表示其他渠道或交付任务已通过验收。ADR-049 的双帧复查仅保留为历史决定。
- 生成只使用已选联系人及用户本人范围内的有界上下文；模型提取的记忆必须带来源、标记 `auto` 且可撤销。
- 正常自动记忆按 ADR-070 与 [ADR-085](adr/085-source-verified-automatic-adoption.md) 使用逐项来源核验，通过适用检查后自动裁决，不以额外语用、置信度或风险标签转入人工待办。来源、人工保护、删除及 ADR-081 的关系矛盾待定例外保持；旧评测结果不因此变成达标。
- 所有实际记忆提取默认保存从原始聊天到最终处理结果的全过程追踪，保留到手动删除或来源删除，追踪写入失败停止本批；含正文资料与最小出站台账分开管理（见 ADR-037，后端及 React 查看/反查/删除已实现，历史／不可观察载荷明确保留缺口；普通页面验证不代替最终原生 App 验收）。
- 关系记忆与本人记忆不设置固定常驻模式；记忆召回第一期按当前正文做确定性中文词法评分，使用独立双预算和相关性阈值；联系人记忆目录只保留版本复验职责。
- 后续 L2/L3 目标按 ADR-067，在关系语境开启时使用受预算限制的 L3 背景与 L2 目录、按需读取正文，同时保留原 L1 动态检索。该分层加载已有受控生产接线，见[运行时装配](../backend-ts/src/reply/sqlite/runtime.ts)与[回复上下文](../backend-ts/src/reply/sqlite/candidates/turns.ts)；默认逐项核验策略与自动启用后续由ADR-070修订；显式评测配置仍保留原资格边界。本机实际运行、真实质量和 App 验收需分别核验；底层记忆仍不添加常驻模式，现有无正文概览的存储合同保持。
- 待确认候选可以参与候选回复，但只能用独立证据类型和独立预算、带强制「未确认」标注作为参考，不得写成确定事实，也不进入已确认记忆集合；用户否决后永久不再参与（见 ADR-035）。
- 候选回复只在应用内展示，最终由用户修改并亲自发送。
- 记忆与 Skill 后续演进按 ADR-048 和正式规格推进：历史状态与当前核实分开，自动学习先形成草稿、集中审核后发布；DSH 搁置决定现由 ADR-102 修订，生产后台现已迁至TypeScript／DSH。长期概览与回复检索已有实现；自动 Skill 学习及方法级控制的具体完成范围按对应任务与代码入口核验，不能由局部接入推断全部功能已启用或通过验收。

## 状态规则

- `已采纳`：放入 `current/` 或记录为已采纳 ADR，可作为实现与测试约束。
- `草案`：放入 `drafts/`，用于探索尚未完全确认的实现设计。
- `已废弃`：由替代 ADR 保留历史原因；从当前阅读路径移除。

新术语写入 `CONTEXT.md`，重要取舍写入 `adr/`，未决设计写入 `drafts/`，代码整改写入 `.scratch/`。每个含义只保留一个权威位置。

[ADR-069](adr/069-direct-scene-memory-and-isolated-publication.md) 记录参考腾讯的直接记忆生成、合并和逐项隔离；[规格](../.scratch/tencent-memory-alignment/spec.md) 区分工程实现、适配差异与真实质量。

[ADR-070](adr/070-automatic-memory-maintenance.md) 记录默认自动维护记忆与旧资料升级退役；实现与验证见[本次规格](../.scratch/automatic-memory-maintenance/spec.md)。

[ADR-081](adr/081-source-grounded-memory-time-and-conditions.md) 记录来源锚点、日期精度、适用条件与有据时间线；[规格与实现索引](../.scratch/memory-temporal-semantics/planning.md) 分别记录目标、工程验证和质量限制。

109. [ADR-109：受控 SQLite 底座与分票切换](adr/109-controlled-sqlite-storage-foundation.md)

110. [ADR-110：SQLite 联系人身份与逐人读取授权](adr/110-selected-sqlite-contact-read-grants.md)

117. [ADR-117：SQLite 记忆候选、决定与版本](adr/117-sqlite-memory-decisions-and-versions.md)

118. [ADR-118：SQLite 场景资料与长期概览的完整发布](adr/118-sqlite-memory-documents-and-publication.md)

129. [ADR-129：DSH 回复 Skill 的受控发现与启用](adr/129-controlled-dsh-reply-skill-discovery.md)
130. [ADR-130：同账号本机来源变化后的明确重新关联](adr/130-explicit-wechat-source-reconfirmation.md)
131. [ADR-131：联系人确认后使用当前可用资料生成](adr/131-available-context-without-history-wait.md)
132. [ADR-132：按会话名称关联已有联系人](adr/132-existing-contact-name-matching.md)

135. [ADR-135：Skill 默认启用与中文场景管理](adr/135-default-enabled-localized-skill-library.md)

136. [ADR-136：回复生成按需组合多个 Skill](adr/136-multi-skill-reply-composition.md)

137. [ADR-137：授权会话同步中的原图保存](adr/137-original-image-authorized-sync.md)
138. [ADR-138：聊天图片原图提取与占位替换](adr/138-chat-image-original-extraction-and-placeholder.md)
139. [ADR-139：引用回复同步与历史补齐](adr/139-quoted-reply-sync-and-history-enrichment.md)

140. [ADR-140：聊天图片取消原图证明门槛](adr/140-source-verified-viewable-chat-images.md)
