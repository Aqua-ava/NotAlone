# 聊天回复策略：工作流状态

更新：2026-10-11。[正式规格](spec.md)及[第三版拆分](ticket-proposal.md)已确认，11张独立任务已发布。主树已集成R01–R07的自主实现和真实公开验证：R02正式46e6af7两用例在主树七场完整复跑exit0／quiet91／cleanuptrue，首次观测exit1及原因未确定的风险保留；R03换组、R05主动目的、R06关键澄清与R07实际Skill同版的负责人正式收口与主树既有独立公开证据一并保留，相关原标准不变、自动范围resolved。A10目录与A11编辑／选择HTTP已正式到位，A12完整讨论及总预算已root28c5验证；R08逐消息编辑与复制仍由B唯一Renderer／Copy端口接A唯一通用版本projection／RPC。R09依A16／17生命周期，R10／R11继续连续要求、新消息和真实跨模块组合。C来源短prefix新反例、pureDraft实际擦除与公开组合仍接续，不能据R01–07预闭。人工、原生、真实App与真实模型语义质量未执行；负责人及主树证据各自归属。

## 任务索引

| 标识 | 正式任务 | Blocked by |
| --- | --- | --- |
| R01 | [conversation-reply-strategy/01 回应场景与明确意愿直达候选](issues/01-response-scene-entry.md) | None (can start immediately) |
| R02 | [conversation-reply-strategy/02 理解、纠正与方向确认闭环](issues/02-understanding-and-direction.md) | [conversation-reply-strategy/01 回应场景与明确意愿直达候选](issues/01-response-scene-entry.md) |
| R03 | [conversation-reply-strategy/03 换组、推荐与暂不回应](issues/03-direction-options-and-pause.md) | [conversation-reply-strategy/02 理解、纠正与方向确认闭环](issues/02-understanding-and-direction.md) |
| R04 | [conversation-reply-strategy/04 明确目的的主动联系入口](issues/04-proactive-purpose-entry.md) | [conversation-reply-strategy/01 回应场景与明确意愿直达候选](issues/01-response-scene-entry.md) |
| R05 | [conversation-reply-strategy/05 主动目的探索与确认](issues/05-purpose-exploration.md) | [conversation-reply-strategy/02 理解、纠正与方向确认闭环](issues/02-understanding-and-direction.md)；[conversation-reply-strategy/04 明确目的的主动联系入口](issues/04-proactive-purpose-entry.md) |
| R06 | [conversation-reply-strategy/06 两种场景的关键澄清与取舍](issues/06-clarification-and-tradeoffs.md) | [conversation-reply-strategy/02 理解、纠正与方向确认闭环](issues/02-understanding-and-direction.md)；[conversation-reply-strategy/04 明确目的的主动联系入口](issues/04-proactive-purpose-entry.md) |
| R07 | [conversation-reply-strategy/07 Skill探索、确认与生成的版本延续](issues/07-skill-version-continuity.md) | [conversation-reply-strategy/02 理解、纠正与方向确认闭环](issues/02-understanding-and-direction.md) |
| R08 | [conversation-reply-strategy/08 候选消息组逐条编辑与复制](issues/08-message-group-edit-copy.md) | [conversation-reply-strategy/04 明确目的的主动联系入口](issues/04-proactive-purpose-entry.md)；[assistant-session-context/11 候选编辑、选择与版本回看](../assistant-session-context/issues/11-candidate-edit-history.md) |
| R09 | [conversation-reply-strategy/09 未选方向时的新消息有界更新](issues/09-bounded-direction-updates.md) | [conversation-reply-strategy/02 理解、纠正与方向确认闭环](issues/02-understanding-and-direction.md)；[assistant-session-context/16 切换会话或关闭小窗时保持生成归属](../assistant-session-context/issues/16-background-result-ownership.md)；[assistant-session-context/17 退出停止与重开后的中断恢复](../assistant-session-context/issues/17-quit-and-interrupted-recovery.md) |
| R10 | [conversation-reply-strategy/10 两种场景的连续修改与消息衔接](issues/10-continuous-scenario-revision.md) | [conversation-reply-strategy/05 主动目的探索与确认](issues/05-purpose-exploration.md)；[conversation-reply-strategy/06 两种场景的关键澄清与取舍](issues/06-clarification-and-tradeoffs.md)；[conversation-reply-strategy/08 候选消息组逐条编辑与复制](issues/08-message-group-edit-copy.md)；[assistant-session-context/13 连续要求、改口与明确编号指代](../assistant-session-context/issues/13-continuous-intent-reference.md)；[assistant-session-context/15 新消息提醒与用户触发重新生成](../assistant-session-context/issues/15-new-message-opt-in.md) |
| R11 | [conversation-reply-strategy/11 策略全路径组合验收](issues/11-combined-strategy-acceptance.md) | [conversation-reply-strategy/03 换组、推荐与暂不回应](issues/03-direction-options-and-pause.md)；[conversation-reply-strategy/07 Skill探索、确认与生成的版本延续](issues/07-skill-version-continuity.md)；[conversation-reply-strategy/09 未选方向时的新消息有界更新](issues/09-bounded-direction-updates.md)；[conversation-reply-strategy/10 两种场景的连续修改与消息衔接](issues/10-continuous-scenario-revision.md) |

## 执行规则

按Blocked by选择前置均完成的任务，在新上下文一次实现一票：读取规格与领域约束→TDD→最小相关及完整相关验证→Standards/Spec评审→记录Answer→本地提交。共享身份和版本约定在首张承接票中明确，不新增只有数据表或接口的任务。

任务发布阶段仅完成规格补充和任务发布，当时未实现或验收产品；当前实施状态见本页更新和各票Answer。OCR、具体邀约Skill、热梗、自动风格学习与外部模型评测保持原边界。跨功能并行见[总览](../unfinished-work/resplit-20261011.md)。

## 2026-10-11 完整来源补充


持久UUID核心公开页面已补21来源记忆并实际通过两场回应／主动闭环；生成适配器重复删除依据的真实HTTP反例已修复，44项相关HTTP/正式001–052 PG和230回复单元通过，自有库剩余0。两轴Spec 0、Standards hard 0，1条测试准备重复P3保留。详情与失败历史见R02；这批证据不替代完整Skill、A12预算、旧七场接续或连续生命周期。接续正式A12 `c4e31ef`、A053及A删除接口，仍沿既有生成链实施。
