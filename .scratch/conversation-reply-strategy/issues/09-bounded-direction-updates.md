# 09：未选方向时的新消息有界更新

State: open
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/02 理解、纠正与方向确认闭环](02-understanding-and-direction.md)；[assistant-session-context/16 切换会话或关闭小窗时保持生成归属](../../assistant-session-context/issues/16-background-result-ownership.md)；[assistant-session-context/17 退出停止与重开后的中断恢复](../../assistant-session-context/issues/17-quit-and-interrupted-recovery.md)

拆分标识：R09（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q27、Q28、Q31。 第二版标识为R08。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

正在进行且方向未选的任务收到消息后更新理解/建议；离开或关闭停止探索更新，已发起候选按会话规则处理。

## Acceptance criteria

- [ ] 只有用户已打开且方向未确认的活跃任务在授权新消息到达时更新理解/建议；不形成全局后台调用。
- [ ] 连续通知合并、有快照和调用次数/超时/重试预算；失败或超预算要求手动刷新，不扩大范围补扫历史。
- [ ] 方向确认、候选生成或编辑后仅提醒；旧探索结果不能覆盖已确认方向。
- [ ] 切换离开或关闭停止探索更新，已发起候选仍按C09继续；退出按C10停止，不另建生命周期模型。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

合并通知、有预算；选定方向后只提醒；旧探索结果不能覆盖已确认方向。明确依赖C09/C10区分视图关闭与退出。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。
