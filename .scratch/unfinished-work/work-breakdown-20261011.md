# 后续工作流导航

更新日期：2026-10-11。本文件仅保留跨功能导航与并行关系，不存放具体草图的完整拆分内容，也不是正式spec或任务票。

## 本次纠正

此前将五份草图的设计交付方向和媒体四票提案集中到同一文件，并称为“拆分方案”，容易让人误以为草图已完成to-spec/to-tickets。实际只完成了盘点与初步建议，没有完成设计收束、正式spec或任务发布。现在按功能归位，原草图保留已确认决定，对应功能目录管理下一步。

## 草图与规格的正确入口

| 材料 | 当前工作流阶段 | 对应目录内的文件 | 是否正式切票 |
| --- | --- | --- | --- |
| 持续会话与上下文 | 从Q16继续收束设计 | [持续会话规划](../assistant-session-context/planning.md) | 否；未决问题解决后先形成spec |
| 聊天回复策略 | 通用流程与共享契约待定，具体Skill仍暂停 | [聊天策略规划](../conversation-reply-strategy/planning.md) | 否 |
| 真实表达与关系感知 | 最小验证范围待定 | [真实表达规划](../authentic-expression/planning.md) | 否 |
| Agent运行时 | 条件触发的能力差距审查 | [运行时规划](../agent-runtime/planning.md) | 否；不默认迁移框架 |
| 云端工程与设备认证 | 云端范围/数据与安全决定待定 | [云端规划](../cloud-engineering/planning.md) | 否；不启动部署 |
| 微信媒体提取 | spec已确认；四票粒度及测试接缝待认可 | [媒体四票提案](../wechat-media-extraction/ticket-proposal.md) | 尚未发布 |

**准确数量：5份草图进入各自的拆分准备文档，另有1份媒体规格对应4票提案；正式新增任务为0张。**

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
- 持续会话和聊天策略可并行整理，共享新消息/候选版本契约需共同定案；真实表达复用该职责边界。
- 媒体四票：受范围资源定位和缓存删除先行，图片/视频与语音之后可并行，最后做手动入口集成。完整内容只在媒体提案维护。
- 新草图不成为现有Mac交付前置。OCR与具体Skill的暂停继续有效。

## 下一步按工作流怎么走

草图先收束未决问题，再在对应功能目录形成spec；确认测试接缝与任务粒度、依赖后，在该目录issues/一票一文件发布。媒体已有spec，可以直接核对提案与接缝。按[仓库工作流](../../docs/agents/workflow.md)发布，不把“规划文件已写”描述为“正式拆票已完成”。
