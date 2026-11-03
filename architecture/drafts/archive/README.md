# 已收束与历史设计归档

> 状态：归档。本目录收录已收束、已完成或已转为历史参考的草案，保留决策背景与追溯入口；不是现行约束，也不作为新的设计入口。

新设计仍写入 `architecture/drafts/`，已采纳规格写入 `architecture/current/`，决定写入 `architecture/adr/`；实际行为以代码和测试为准。

| 文件 | 收束依据 |
| --- | --- |
| [recall-phase-1.md](recall-phase-1.md) | ADR-028；行为已回填 `current/` |
| [reply-module-structure.md](reply-module-structure.md) | ADR-012；ADR-090 局部替代；对应任务已关闭 |
| [website-visual-direction.md](website-visual-direction.md) | 官网任务已关闭；实际页面见 `website/` |
| [Agent 编排与检索运行时](agent-runtime.md) | ADR-102／106／109；框架、会话与存储分别已有后继；现行入口见 [`core-flows.md`](../../current/core-flows.md) |
| [助手会话持久化与空闲分段](assistant-session-persistence.md) | ADR-106 已承接已确认规则与验证入口；现行入口见 [`core-flows.md`](../../current/core-flows.md) |
| [持续会话与上下文管理](assistant-session-context.md) | 正式规格已收束；ADR-106 修订续用与历史选择；现行入口见 [`core-flows.md`](../../current/core-flows.md) |
| [聊天回复策略](conversation-reply-strategy.md) | 第一版已形成正式规格；ADR-079／136 修订入口与 Skill 组合；现行入口见 [`core-flows.md`](../../current/core-flows.md) |
| [DSH Skill 接入与业务校验](dsh-skill-integration.md) | ADR-129／135／136 及现行 Skill 规格承接接入与组合规则；现行入口见 [`skill-library.md`](../../current/skill-library.md) |
| [记忆与 Skill 演进](memory-skill-evolution.md) | 正式规格与 ADR-048 承接；后续规则见现行数据、流程与 Skill 规格；现行入口见 [`domain-data.md`](../../current/domain-data.md) |
| [L2 场景文档与 L3 长期画像联合设计](layered-relationship-memory.md) | 正式规格与 ADR-067 承接；调度与自动使用按现行规格；现行入口见 [`domain-data.md`](../../current/domain-data.md) |

原 `drafts/` 路径保留简短兼容页，供历史任务跳转；正常开发从[架构阅读入口](../../README.md)定位现行规格。归档依据是已有正式承接或明确替代，不以文件日期判断失效。
