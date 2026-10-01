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
2. 按任务读取一份或多份现行规格：[`domain-data.md`](current/domain-data.md)、[`core-flows.md`](current/core-flows.md)、[`privacy-deletion.md`](current/privacy-deletion.md)、[`skill-library.md`](current/skill-library.md)。
3. 只有涉及云端部署、回复运行时或真实表达质量时，才读取对应草案：[`cloud-engineering.md`](drafts/cloud-engineering.md)、[`agent-runtime.md`](drafts/agent-runtime.md)、[`authentic-expression.md`](drafts/authentic-expression.md)。
4. 当现行规格或草案引用 ADR 时，再读取对应决策；复审既有决定时必须新增 ADR 修订或替代，不能覆盖历史原因。
5. 整体关系可查看 [NotAlone 架构图](notalone-system-architecture.drawio)；架构图同样不代表运行时验证。

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

## 当前架构决策

- 采用云端模块化单体，PostgreSQL 是联系人、消息、关系资料、任务和删除状态的权威业务库。
- 数据隔离键为 `owner_id + contact_id`；`contact_id` 由 NotAlone 创建，昵称、备注和微信来源标识不能替代它。
- 文字是统一的检索与生成表示；前台 display name OCR、本地微信 CLI、截图和语音都是输入适配器。
- Mac 前台 OCR 由 display name 和左侧选中会话元数据优先定位当前会话，头像视觉指纹只作备用；CLI 独立同步用户主动选择并确认的联系人及我方文字增量，首次不预选会话。CLI 的外部会话标识不能替代 `contact_id`，同步范围与停止/恢复规则见 ADR-030。
- 生成只使用已选联系人及用户本人范围内的有界上下文；模型提取的记忆必须带来源、标记 `auto` 且可撤销。
- 关系记忆与本人记忆不设置固定常驻模式；记忆召回第一期按当前正文做确定性中文词法评分，使用独立双预算和相关性阈值；联系人记忆目录只保留版本复验职责。
- 候选回复只在应用内展示，最终由用户修改并亲自发送。

## 状态规则

- `已采纳`：放入 `current/` 或记录为已采纳 ADR，可作为实现与测试约束。
- `草案`：放入 `drafts/`，用于探索尚未完全确认的实现设计。
- `已废弃`：由替代 ADR 保留历史原因；从当前阅读路径移除。

新术语写入 `CONTEXT.md`，重要取舍写入 `adr/`，未决设计写入 `drafts/`，代码整改写入 `.scratch/`。每个含义只保留一个权威位置。
