# 10：两种场景的连续修改与消息衔接

State: open
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/05 主动目的探索与确认](05-purpose-exploration.md)；[conversation-reply-strategy/06 两种场景的关键澄清与取舍](06-clarification-and-tradeoffs.md)；[conversation-reply-strategy/08 候选消息组逐条编辑与复制](08-message-group-edit-copy.md)；[assistant-session-context/13 连续要求、改口与明确编号指代](../../assistant-session-context/issues/13-continuous-intent-reference.md)；[assistant-session-context/15 新消息提醒与用户触发重新生成](../../assistant-session-context/issues/15-new-message-opt-in.md)

拆分标识：R10（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q7、Q10、Q11、Q28、Q31。 第二版标识为R09。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

回应与主动聊天都能修改目的、引用组内候选，并在新消息后由用户决定是否结合继续。

## Acceptance criteria

- [ ] 回应和主动路径均支持改口、明确引用组内候选及澄清后继续，目的、方向、候选组和输入版本一致。
- [ ] 新消息由用户决定是否结合，复用C06/C08的连续要求、快照和迟到失效规则，不新建另一套取消或存储。
- [ ] 旧建议、旧问题、旧候选版本不能应用到新输入；越权与来源删除清理新增讨论及派生结果。
- [ ] 不依赖未选方向自动更新R09；手动连续修改可独立验收。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

复用C系版本与失效规则，不再实现另一套；组、方向、改口及消息快照保持一致。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。
