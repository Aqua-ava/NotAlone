# 后续工作流导航

更新日期：2026-10-11。本文件仅保留跨功能导航与并行关系，不存放具体草图的完整拆分内容，也不是正式spec或任务票。

最新状态：[三份规格第三版发布](resplit-20261011.md)，13+11+6共30张独立任务已发布，全部未开工；持续会话原六票仅拆分替代、未实现验收。

## 本次纠正

此前将五份草图的设计交付方向和媒体四票提案集中到同一文件，并称为“拆分方案”，容易让人误以为草图已完成to-spec/to-tickets。实际只完成了盘点与初步建议，没有完成设计收束、正式spec或任务发布。现在按功能归位，原草图保留已确认决定，对应功能目录管理下一步。

## 草图与规格的正确入口

| 材料 | 当前工作流阶段 | 对应目录内的文件 | 是否正式切票 |
| --- | --- | --- | --- |
| 持续会话与上下文 | spec保留；13票已发布，未开工 | [持续会话规划](../assistant-session-context/planning.md) | 是；07–19，旧01–06仅拆分替代 |
| 聊天回复策略 | 第一版spec及11票已发布，未开工；具体Skill暂停 | [聊天策略规划](../conversation-reply-strategy/planning.md) | 是；01–11 |
| 真实表达与关系感知 | 第一版spec及6票已发布，未开工 | [真实表达规划](../authentic-expression/planning.md) | 是；01–06 |
| Agent运行时 | 条件触发的能力差距审查 | [运行时规划](../agent-runtime/planning.md) | 否；不默认迁移框架 |
| 云端工程与设备认证 | 云端范围/数据与安全决定待定 | [云端规划](../cloud-engineering/planning.md) | 否；不启动部署 |
| 微信媒体提取 | spec已确认；四票粒度及测试接缝待认可 | [媒体四票提案](../wechat-media-extraction/ticket-proposal.md) | 尚未发布 |

**准确数量：5份原草图中，3份已形成正式spec并发布13/11/6共30张当前任务；另外2份仍在规划阶段。另有1份媒体规格对应4票提案，尚未发布。持续会话旧六票是替代历史，不重复计入待实现范围。**

## 已发布任务继续回原票处理

- [真实微信04](../native-app-backend/issues/04-real-wechat-follow-smoke.md)：来信事件触发、双联系人和退出等剩余检查。
- [Mac18](../mac-desktop-app/issues/18-foreground-locator.md)：OCR按用户要求暂停，保持原验收条件。
- [Mac20](../mac-desktop-app/issues/20-mac-app-delivery.md)：来源与许可、最终包原生能力和完整交付。
- [核心事实01](../memory-core-claim-retention/issues/01-diagnose-fix-and-replay.md)：新对照或目标决定；旧预算关闭。
- [指代07](../memory-extraction-accuracy/issues/07-reference-resolution.md)：当前16条基线与修复，需模型/配置和新预算。
- [维度放行03](../memory-accuracy-next/issues/03-per-dimension-rollout.md)：字段与质量证据，默认空放行表不变。

不因此次归档新建重复票、不回写上述任务的Blocked by、不改验收条件。Windows仍是待定后续方向，尚无正式规格。

## 跨功能并行关系

- Mac来源核查、记忆评测离线准备与草图问题整理可并行；真实桌面验收共用微信与前台，由主Agent串行操作。
- 三份规格按C/R/E第三版依赖图安排并行，初始C01、R01、E01、E04互不阻塞；正式路径和Blocked by见各自planning，旧六票不再执行。
- 媒体四票：受范围资源定位和缓存删除先行，图片/视频与语音之后可并行，最后做手动入口集成。完整内容只在媒体提案维护。
- 新草图不成为现有Mac交付前置。OCR与具体Skill的暂停继续有效。

## 下一步按工作流怎么走

三份规格任务已发布；下一步按依赖一次选择一票，在新上下文完成TDD、相关验证、Standards/Spec评审与本地提交。其余草图先收束未决问题，再在对应目录形成spec；媒体已有spec，继续核对自身提案与测试接缝。按[仓库工作流](../../docs/agents/workflow.md)执行，任务发布不等于产品实现。
