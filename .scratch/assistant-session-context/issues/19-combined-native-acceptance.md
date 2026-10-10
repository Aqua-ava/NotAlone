# 19：持续会话组合与真实App生命周期验收

State: open
Triage: ready-for-agent
Blocked by: [assistant-session-context/08 重新连接后恢复已保存会话](08-saved-session-recovery.md)；[assistant-session-context/09 用户删除一段助手会话](09-delete-assistant-session.md)；[assistant-session-context/13 连续要求、改口与明确编号指代](13-continuous-intent-reference.md)；[assistant-session-context/15 新消息提醒与用户触发重新生成](15-new-message-opt-in.md)；[assistant-session-context/16 切换会话或关闭小窗时保持生成归属](16-background-result-ownership.md)；[assistant-session-context/17 退出停止与重开后的中断恢复](17-quit-and-interrupted-recovery.md)；[assistant-session-context/18 显式携候选新开与满会话分流](18-carry-selected-candidate.md)

拆分标识：C13（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧06；Q1–Q18组合。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

组合验证双联系人、多会话、预算、修改及删除，再以有限真实App窗口核对关闭/退出/恢复。

## Acceptance criteria

- [ ] 以双合成联系人、多会话串联恢复、版本、连续修改、消息更新、预算、新开及删除；仅增加组合场景，复用前票回归。
- [ ] 验证多来源、后继候选及携候选的传递删除，重读/恢复/再生成不取得已删内容，无关讨论仍存在。
- [ ] 按项目门禁在有限真实App窗口验证小窗关闭继续、真正退出停止及重开中断；记录实际命令、清理和原生结果。
- [ ] 没有真实App证据时原生验收保持未完成，不能仅凭页面通过关闭本票；不读取微信、不恢复OCR、不调用外部模型。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

复用前票回归，仅增加交叉场景；无真实App证据时保持原生项未完成，不重复制造新功能。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。
