# 18：显式携候选新开与满会话分流

State: open
Triage: ready-for-agent
Blocked by: [assistant-session-context/10 新开、列出与选择旧会话](10-session-list-and-new.md)；[assistant-session-context/11 候选编辑、选择与版本回看](11-candidate-edit-history.md)；[assistant-session-context/12 模型预算提醒与超限拒绝](12-input-budget-guard.md)

拆分标识：C12（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧05；Q3、Q17新开。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

在普通或已满会话中选择全新开始，或只带指定候选新开；临时要求与整段讨论不被搬入。

## Acceptance criteria

- [ ] 普通或已满会话都能选择全新开始，或只携用户明确选中的候选版本；不携整段讨论和临时要求。
- [ ] 携入前复验候选、范围与原始来源，失效候选拒绝；新会话不自动生成，旧会话仍可查看。
- [ ] 携入内容维持来源传递依赖，来源删除覆盖新旧会话相关副本；保留不依赖该来源的讨论。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

包含候选/来源复验、仅选择版本的内容、来源依赖传递及删除；不是复制整份历史。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。
