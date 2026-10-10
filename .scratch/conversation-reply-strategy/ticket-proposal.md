# 聊天回复策略：第三版拆分与发布映射（11票）

更新：2026-10-11。用户已认可复审修订；本版已按依赖顺序发布，一票一文件。三份正式规格保留，表达样本留存补充按用户明确选择及ADR-044执行。C/R/E只是方案定位标识；正式身份、Blocked by和验收以链接的任务为准。

## 拆分原则

每票交付可独立验证的完整行为，包含所需存储、接口、界面与测试；E01作为离线评测工具，通过报告入口完成闭环。隔离、来源删除、最小日志和失效检查随新增路径交付，不等最后验收补安全。

| 标识 | 正式任务 | Blocked by（标识） | 交付 |
| --- | --- | --- | --- |
| R01 | [conversation-reply-strategy/01 回应场景与明确意愿直达候选](issues/01-response-scene-entry.md) | 无 | 明确选择回应消息场景、目标消息和意愿后生成，已有草稿改写仍可进入并保留内容。 |
| R02 | [conversation-reply-strategy/02 理解、纠正与方向确认闭环](issues/02-understanding-and-direction.md) | R01 | 未明确意愿时展示简短理解与不同方向；纠正只更新理解和建议，用户明确给出方向或确认建议后才生成候选。 |
| R03 | [conversation-reply-strategy/03 换组、推荐与暂不回应](issues/03-direction-options-and-pause.md) | R02 | 用户可换方向组或自己填写，系统可说明推荐但不预选；选择晚点回复得到不生成候选的有效结果。 |
| R04 | [conversation-reply-strategy/04 明确目的的主动联系入口](issues/04-proactive-purpose-entry.md) | R01 | 没有对方目标消息时，用户明确说明目的，直接比较开口方式与候选。 |
| R05 | [conversation-reply-strategy/05 主动目的探索与确认](issues/05-purpose-exploration.md) | R02, R04 | 用户只有“想聊聊”等模糊目的时，先探索不同目的与开口方向；用户确认目的后直接进入主动候选路径。 |
| R06 | [conversation-reply-strategy/06 两种场景的关键澄清与取舍](issues/06-clarification-and-tradeoffs.md) | R02, R04 | 回应或主动联系时，只有会改变立场、形成承诺或造成实质歧义的未知项才提出一个关键问题；用户回答后在目的或方向已明确时继续候选生成，仍不明确则回到探索/确认，并能看到复杂目的当前一步和表达取舍。 |
| R07 | [conversation-reply-strategy/07 Skill探索、确认与生成的版本延续](issues/07-skill-version-continuity.md) | R02 | 启用的有效场景Skill辅助理解和方向，显示实际版本并可关闭或更换；从探索、确认到候选生成沿用同一有效选择，无匹配或明确关闭时仍可走通通用流程。 |
| R08 | [conversation-reply-strategy/08 候选消息组逐条编辑与复制](issues/08-message-group-edit-copy.md) | R04, C05 | 回应或主动候选以备选方案及组内有序消息展示，逐条编辑复制并保存版本。 |
| R09 | [conversation-reply-strategy/09 未选方向时的新消息有界更新](issues/09-bounded-direction-updates.md) | R02, C09, C10 | 正在进行且方向未选的任务收到消息后更新理解/建议；离开或关闭停止探索更新，已发起候选按会话规则处理。 |
| R10 | [conversation-reply-strategy/10 两种场景的连续修改与消息衔接](issues/10-continuous-scenario-revision.md) | R05, R06, R08, C06, C08 | 回应与主动聊天都能修改目的、引用组内候选，并在新消息后由用户决定是否结合继续。 |
| R11 | [conversation-reply-strategy/11 策略全路径组合验收](issues/11-combined-strategy-acceptance.md) | R03, R07, R09, R10 | 公开页面→HTTP/PG组合验证两条路径、方向探索、Skill、消息组与持续修改的隔离/删除和调用边界。 |

## 本次复审修订

第二版R05拆为本版R05目的探索与R06两场景澄清；原R06–R10依次变为R07–R11。R02纠正理解不等于确认方向；R07覆盖探索→确认→生成的Skill版本及明确关闭；R01主要是既有路径的场景兼容增量。R10不依赖R09自动更新，R11最后汇合。

## 依赖、验证与下一步

[总览](../unfinished-work/resplit-20261011.md)记录跨规格依赖和旧票替代；[本功能工作流](planning.md)记录执行入口。共享模块修改需协调合并，不自动成为额外业务阻塞。每票执行自身最小验证，最后组合票只增加交叉证据。真实App和模型语义分别据实报告，OCR继续暂停。
