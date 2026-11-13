# 记忆与 Skill 演进：任务索引与工作流状态

> 2026-10-21 设计审查：正常默认维护及旧资料升级退役由 [ADR-070](../../architecture/adr/070-automatic-memory-maintenance.md) 修订，个人 L2/L3 有据推断由 [ADR-072](../../architecture/adr/072-personal-memory-insights-without-action-guidance.md) 修订，失效版本禁止生成由 [ADR-080](../../architecture/adr/080-unified-memory-list-and-retired-exclusion.md) 修订，主动样本由 [ADR-082](../../architecture/adr/082-retire-explicit-style-samples.md) 退役。本文旧开关、空表／全局质量资格、推断禁令和升级入口不再全数作为现行产品要求；历史 qualified_suite 成绩、unknown 与原验收结论保持，不能改写为当前质量通过。当前入口为 architecture/current/，旧流程的来源／删除与人工保护仍有效。

> 更新：2026-10-17。15 项交付已由记忆与 Skill 集成票签收，并随 `memory-skill-integration@2f1880ae` 集成链经本地 main 收敛进入 main；本索引按交付事实同步为 resolved，2026-10-14 的发布记录保留在各票 Comments。
> [正式规格](spec.md)、[已确认拆分](ticket-proposal.md)、[ADR-048](../../architecture/adr/048-memory-skill-evolution-lifecycle.md)。DSH 搁置，不进入任务或阻塞关系。

## 正式任务

| 编号 | 任务 | State | Blocked by |
| --- | --- | --- | --- |
| 01 | [历史状态与当前未核实](issues/01-historical-current-status.md) | resolved | None |
| 02 | [新旧更新、事件与去重](issues/02-memory-event-update-dedup.md) | resolved | 01 |
| 03 | [纠错、否决与防止旧错误回来](issues/03-correction-rejection-regrowth.md) | resolved | None |
| 04 | [旧回复依据变化与重新生成](issues/04-historical-reply-evidence-change.md) | resolved | 01, 03 |
| 05 | [联系人关系变化概览](issues/05-contact-relationship-overview.md) | resolved | 01, 02, 03 |
| 06 | [本人事实与偏好概览](issues/06-owner-facts-preferences-overview.md) | resolved | 01, 02, 03 |
| 07 | [概览与有界证据检索接入回复](issues/07-overview-evidence-reply-retrieval.md) | resolved | 05, 06 |
| 08 | [明确长期表达偏好的管理与使用](issues/08-explicit-expression-preferences.md) | resolved | None |
| 09 | [自动学习并形成待审核草稿](issues/09-automatic-skill-drafts.md) | resolved | None |
| 10 | [对照审核、范围确认与发布使用](issues/10-skill-review-scope-publication.md) | resolved | 09 |
| 11 | [Skill 更新、合并与回滚](issues/11-skill-update-merge-rollback.md) | resolved | 10 |
| 12 | [当前回复与方法反馈调整](issues/12-scoped-skill-feedback.md) | resolved | 10 |
| 13 | [旧资料的差异比较与批次升级](issues/13-legacy-memory-comparison-upgrade.md) | resolved | 01, 02, 03 |
| 14 | [语义检索已有缺口的独立评估](issues/14-semantic-retrieval-gap-evaluation.md) | resolved | None |
| 15 | [记忆到 Skill 的跨功能组合验收](issues/15-combined-evolution-acceptance.md) | resolved | 04, 07, 08, 11, 12, 13 |

## 交付对应与执行状态（2026-10-17）

按真实前置依赖选择任务，在独立上下文一次推进一票；任务状态与 Answer 是执行证据。原 15 票已于 2026-10-17 按交付事实收口，不再作为可领取队列。

交付由 [memory-skill-integration-preparation](../memory-skill-integration-preparation/planning.md) 的集成票签收（编号并非一一对应）：01→01、02→03、03→02、04→04、05→05、06→06、07→07、08→08、09→09、10→11、11→12、12→13、13→10、14→14、15→15。每票 Answer 记录对应集成票链接；`memory-skill-integration@2f1880ae` 经[本地 main 收敛](../main-consolidation/branch-audit.md)进入 main，当前 HEAD 包含迁移 063–070 及对应实现。

本收口只同步索引，不重跑实验、不新增真实模型或 App／渠道验收，也不改变自动采纳放行表、语义检索开关或原有真实质量边界。后续若要扩展这些功能，应另立新票。

## 执行与验收规则

- 开始实现时将单票 State 改为 claimed；完成本票验收、两轴评审和实际 Answer 后才改为 resolved，并同步本索引。
- 读取本票、规格、前置任务和领域约束，复用公开 HTTP/隔离 PostgreSQL/当前 React 控制器等已约定测试接口；共享接口由首张承接票建立，后续保持兼容。
- 每票负责自己的来源、隔离、删除、迟到结果和恢复，不把这些行为拖到15才实现。15组合验证各票实际交付；真实模型质量和实际 App/渠道证据另行记录。
- 保留当前自动采纳质量门槛及语义检索失败基线；新增字段、合成测试或任务关闭不自动放行维度或启用向量检索。
- 执行涉及真实数据、模型出站、业务迁移、原生 App 验收或远端发布时，按既有明确范围与工程要求推进；本地任务发布不扩大这些授权。

## 功能对应

| 产品功能 | 正式任务 |
| --- | --- |
| 记忆持续更新 | 01、02 |
| 记忆纠错 | 03、04 |
| 长期概览 | 05、06 |
| 检索辅助回复 | 07；14独立评估 |
| 明确表达偏好 | 08 |
| 自动学习 Skill | 09、10、11 |
| 根据反馈调整 Skill | 12；11保持反馈政策 |
| 现有资料升级 | 13 |
| 跨功能验收 | 15 |
