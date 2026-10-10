# 持续会话与上下文管理：工作流状态

更新日期：2026-10-11。用户已确认 Q1–Q18、测试接缝、六票粒度与依赖。

## 当前阶段

[正式 spec](spec.md)与六张独立实现任务已发布；[ADR-042](../../architecture/adr/042-assistant-session-context-boundary.md)已明确助手讨论不压缩的边界。设计收束、规格及拆票完成，功能实现和验收尚未开始。

## 已发布任务

| 任务 | State | Blocked by |
| --- | --- | --- |
| [01 创建、恢复和删除一段助手会话](issues/01-session-lifecycle.md) | open | 无，可开始 |
| [02 连续修改、明确指代和候选版本](issues/02-continuous-revision.md) | open | 01 |
| [03 生成中新要求和新消息的处理](issues/03-generation-replacement.md) | open | 02 |
| [04 会话列表、切换及应用生命周期](issues/04-switch-and-exit.md) | open | 03 |
| [05 长度预算与显式携候选新开](issues/05-budget-and-carry.md) | open | 04 |
| [06 完整合成回归与真实 App 生命周期验收](issues/06-integrated-acceptance.md) | open | 05 |

依赖：01 → 02 → 03 → 04 → 05 → 06。当前可执行前沿为 01；其余任务 ready-for-agent 表示材料齐备，仍须等待前置完成。原票是执行状态的权威来源。

## 接续

在新实现上下文读取 01、spec、CONTEXT、相关 ADR 与仓库工作流，按 TDD、相关验证、Standards/Spec 评审和本地提交推进。完成后在原票写 Answer，更新状态和总览。最终真实 App 生命周期需要有限验证窗口，不能预写通过。

[原产品讨论](../../architecture/drafts/assistant-session-context.md)保留确认事实，[原拆分提案](ticket-proposal.md)保留核验来源；已发布范围以 spec 和独立任务为准。OCR、自沉淀、自动摘要、框架迁移均不纳入本轮。
