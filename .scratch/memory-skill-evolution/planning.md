# 记忆与 Skill 演进：任务索引与工作流状态

> 更新：2026-10-14。用户已确认15项粒度与依赖，任务已逐张发布。当前仅完成规格与任务发布，产品实现尚未开始。
> [正式规格](spec.md)、[已确认拆分](ticket-proposal.md)、[ADR-048](../../architecture/adr/048-memory-skill-evolution-lifecycle.md)。DSH 搁置，不进入任务或阻塞关系。

## 正式任务

| 编号 | 任务 | State | Blocked by |
| --- | --- | --- | --- |
| 01 | [历史状态与当前未核实](issues/01-historical-current-status.md) | open | None |
| 02 | [新旧更新、事件与去重](issues/02-memory-event-update-dedup.md) | open | 01 |
| 03 | [纠错、否决与防止旧错误回来](issues/03-correction-rejection-regrowth.md) | open | None |
| 04 | [旧回复依据变化与重新生成](issues/04-historical-reply-evidence-change.md) | open | 01, 03 |
| 05 | [联系人关系变化概览](issues/05-contact-relationship-overview.md) | open | 01, 02, 03 |
| 06 | [本人事实与偏好概览](issues/06-owner-facts-preferences-overview.md) | open | 01, 02, 03 |
| 07 | [概览与有界证据检索接入回复](issues/07-overview-evidence-reply-retrieval.md) | open | 05, 06 |
| 08 | [明确长期表达偏好的管理与使用](issues/08-explicit-expression-preferences.md) | open | None |
| 09 | [自动学习并形成待审核草稿](issues/09-automatic-skill-drafts.md) | open | None |
| 10 | [对照审核、范围确认与发布使用](issues/10-skill-review-scope-publication.md) | open | 09 |
| 11 | [Skill 更新、合并与回滚](issues/11-skill-update-merge-rollback.md) | open | 10 |
| 12 | [当前回复与方法反馈调整](issues/12-scoped-skill-feedback.md) | open | 10 |
| 13 | [旧资料的差异比较与批次升级](issues/13-legacy-memory-comparison-upgrade.md) | open | 01, 02, 03 |
| 14 | [语义检索已有缺口的独立评估](issues/14-semantic-retrieval-gap-evaluation.md) | open | None |
| 15 | [记忆到 Skill 的跨功能组合验收](issues/15-combined-evolution-acceptance.md) | open | 04, 07, 08, 11, 12, 13 |

## 执行顺序

按真实前置依赖选择任务，在独立上下文一次推进一票；任务状态与 Answer 是执行证据，发布不等于完成。
目前没有技术前置的任务为01、03、08、09、14。按已确认优先级，先推进01与03，再做02，随后完成04～07的概览及回复链路；08可独立交付，Skill阶段按09→10→11/12推进。13在01～03完成后可做比较升级；14独立评估，不阻塞生产功能。
建议下一张从[01：历史状态与当前未核实](issues/01-historical-current-status.md)开始。本轮发布未领取任何任务，不自动进入实现。

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
