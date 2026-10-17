# NotAlone 架构文档

> 状态：已建立。本目录区分现行约束、设计草案与 ADR；文档不代表对应功能已经实现。

## 文档分层

| 位置 | 唯一职责 |
| --- | --- |
| [`CONTEXT.md`](../CONTEXT.md) | 统一领域词汇，只定义概念。 |
| [`current/`](current/) | 已采纳、当前实现必须遵守的规格。 |
| [`drafts/`](drafts/) | 尚未全部确认或实现的设计，不作为现行约束。 |
| [`adr/`](adr/) | 难以逆转且存在真实取舍的架构决策及原因。 |
| [`.scratch/`](../.scratch/) | 功能规格和可执行任务，不在架构文档中积累待办。 |

已完成的评审过程不保留为当前架构文档；Git 历史负责保存旧版本。实际行为以代码和测试为准，不能用架构文档证明功能已经实现。

## 按任务阅读

1. 先读根目录 [`CONTEXT.md`](../CONTEXT.md)，使用统一领域语言。
2. 按任务读取一份或多份现行规格：[`domain-data.md`](current/domain-data.md)、[`core-flows.md`](current/core-flows.md)、[`privacy-deletion.md`](current/privacy-deletion.md)、[`skill-library.md`](current/skill-library.md)。涉及记忆提取溯源时，再读 [`memory-extraction-trace.md`](current/memory-extraction-trace.md)；全过程后端与 React 查看入口已实现并经合成验证，最终原生 App/渠道验收另按原任务推进。
3. 只有涉及云端部署、回复运行时或真实表达质量时，才读取对应草案：[`cloud-engineering.md`](drafts/cloud-engineering.md)、[`agent-runtime.md`](drafts/agent-runtime.md)、[`authentic-expression.md`](drafts/authentic-expression.md)。
4. 当现行规格或草案引用 ADR 时，再读取对应决策；复审既有决定时必须新增 ADR 修订或替代，不能覆盖历史原因。
5. 整体关系可查看 [NotAlone 架构图](notalone-system-architecture.drawio)；架构图同样不代表运行时验证。

聊天辅助产品讨论分别记录在[聊天回复策略草图](drafts/conversation-reply-strategy.md)和[持续会话与上下文管理草图](drafts/assistant-session-context.md)：前者讨论回应与主动联系两条路径，后者从 Q1 独立记录助手会话连续性及新开边界，均未替代现行规格。

记忆持续更新、纠错、概览、回复检索及自动 Skill 学习等 8 个完整功能，已从[草图](drafts/memory-skill-evolution.md)整理为[正式规格](../.scratch/memory-skill-evolution/spec.md)；[15项拆分](../.scratch/memory-skill-evolution/ticket-proposal.md)已确认并逐张发布，实际进度见[任务索引](../.scratch/memory-skill-evolution/planning.md)。DSH 选型搁置，不阻塞本轮交付；当前仅发布规格与任务，功能尚未据此实现。

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
44. [ADR-044：主动保存的表达样本独立于助手会话留存](adr/044-explicit-style-sample-retention.md)
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

## 当前架构决策

- 旧 Swift 主界面已按 ADR-039 退役；共享前端采用 TypeScript + React，由 ADR-040 的 Electron 双窗口宿主承载；已接通业务页面，完整原生验收仍未完成。Python 后台与 Mac 原生探针保留。
- 独立桌面版按 ADR-061 采用本机受管后台与 PostgreSQL，资料保存在本机；新装交付与最终验收状态分别核验。按 ADR-066，已有安装保留原数据库连接与资料位置，仅原地执行缺少的版本化 SQL，取消普通启动中的强制备份与复制切换；没有既有配置的新安装正常初始化空受管库。旧云端模块化单体目标不作为独立版的默认数据去向，PostgreSQL 仍是联系人、消息、关系资料、任务和删除状态的权威业务库。
- 首版范围按 ADR-065 先交付手动粘贴聊天文字或单联系人导入的完整使用路径，明确创建／选择联系人后生成、查看依据及编辑候选。微信自动初始化与渠道验收保留未完成，不作为本次首版前提；资料更新按 ADR-066 原地补齐，历史副本删除清理、隐私与人工发送要求保持。
- 数据隔离键为 `owner_id + contact_id`；`contact_id` 由 NotAlone 创建，昵称、备注和微信来源标识不能替代它。
- 文字是统一的检索与生成表示；前台 display name OCR、本地微信 CLI、截图和语音都是输入适配器。
- Mac 前台 OCR 按 ADR-052 仅识别顶部 display name，再由唯一私聊元数据及已确认绑定定位联系人；CLI 独立同步用户主动选择并确认的联系人及我方文字增量，首次不预选会话。CLI 的外部会话标识不能替代 `contact_id`，同步范围与停止/恢复规则见 ADR-030。
- 持续前台定位按 ADR-050 采用每轮单帧，进入助手或其他 App 后暂停；一个助手窗口按联系人恢复输入和编辑，切换不取消原生成。此项已形成[正式规格](../.scratch/foreground-contact-follow/spec.md)，[任务01](../.scratch/foreground-contact-follow/issues/01-single-frame-locator.md)已完成现有单次单帧链路的代码及合成验证；[任务02](../.scratch/foreground-contact-follow/issues/02-contact-content-restore.md)已完成手动切换的输入与候选编辑恢复及 HTTP/PG 合成验证；[任务03](../.scratch/foreground-contact-follow/issues/03-explicit-generation-context.md)已实现显式生成、准备回执固定有界上下文和补查范围，完成 HTTP/PG 合成验证；持续流程和实机验收仍待完成。ADR-049 的双帧复查仅保留为历史决定。
- 生成只使用已选联系人及用户本人范围内的有界上下文；模型提取的记忆必须带来源、标记 `auto` 且可撤销。
- 自动采纳在原有语用、置信度与风险门槛之上要求相关维度全部有当前来源依据并逐类获批；现采用保守相关超集。默认放行表为空，未知或未放行项安静待确认；质量达标和字段可用分别验证，运维回退保持（见 ADR-036、ADR-046、[放行台账](../docs/memory-adoption-dimension-release-ledger.md)）。
- 所有实际记忆提取默认保存从原始聊天到最终处理结果的全过程追踪，保留到手动删除或来源删除，追踪写入失败停止本批；含正文资料与最小出站台账分开管理（见 ADR-037，后端及 React 查看/反查/删除已实现，历史／不可观察载荷明确保留缺口；普通页面验证不代替最终原生 App 验收）。
- 关系记忆与本人记忆不设置固定常驻模式；记忆召回第一期按当前正文做确定性中文词法评分，使用独立双预算和相关性阈值；联系人记忆目录只保留版本复验职责。
- 待确认候选可以参与候选回复，但只能用独立证据类型和独立预算、带强制「未确认」标注作为参考，不得写成确定事实，也不进入已确认记忆集合；用户否决后永久不再参与（见 ADR-035）。
- 候选回复只在应用内展示，最终由用户修改并亲自发送。
- 记忆与 Skill 后续演进按 ADR-048 和正式规格推进：历史状态与当前核实分开，自动学习先形成草稿、集中审核后发布；DSH 选型搁置。此项是待实现的目标约束，不表示当前已有自动 Skill 学习、长期概览或方法级停用。

## 状态规则

- `已采纳`：放入 `current/` 或记录为已采纳 ADR，可作为实现与测试约束。
- `草案`：放入 `drafts/`，用于探索尚未完全确认的实现设计。
- `已废弃`：由替代 ADR 保留历史原因；从当前阅读路径移除。

新术语写入 `CONTEXT.md`，重要取舍写入 `adr/`，未决设计写入 `drafts/`，代码整改写入 `.scratch/`。每个含义只保留一个权威位置。
