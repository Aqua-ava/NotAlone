# 01：创建、恢复和删除一段助手会话

State: open
Triage: ready-for-agent
Blocked by: None (can start immediately)

## 规格与范围

[正式规格](../spec.md)，覆盖 Q1、Q4、Q10、Q18。读取 [工作流](../../../docs/agents/workflow.md)、[领域语言](../../../CONTEXT.md)及 [ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。本票交付范围如下；不要提前实现后续票或恢复 OCR。

## What to build

为已确认联系人创建助手会话，提交一次回复请求，保存讨论及候选；重新连接后可查看，主动删除后无法恢复。

## Acceptance criteria

- [ ] 跨 owner/contact 读取和提交拒绝。
- [ ] 恢复不自动生成。
- [ ] 同键重试不重复。
- [ ] 来源删除清理这一轮及恢复副本并显示占位，无关内容保留。删除/失效竞态从第一票就覆盖，不留到最终验收补安全。
- [ ] 新增路径遵守 owner/contact 隔离、来源删除、最小日志及人工发送边界。
- [ ] 在规格已确认的公开接缝完成相关验证，记录实际命令、结果、数据影响及剩余风险；不能把合成结果当作真实 App 或模型质量证明。

本票只完成默认会话的一次生成、可靠恢复和删除；多轮版本、列表切换及长度新开体验由后续票交付，既有生成预算门禁不能被绕过。

## 验证与交付

使用公开桌面操作、后端 HTTP 和隔离 PostgreSQL，模型及消息输入使用合成适配器；安全和竞态在应用入口验证。按 TDD 垂直推进，不拆成只有数据库或只有 UI 的交付。完成后按工作流进行 Standards/Spec 两轴评审、本地提交，并在本票写 Answer；没有证据不改为 resolved。

真实 App 仅由主 Agent 在另行约定的有限窗口通过项目入口执行；普通验证不启动 App、不读取微信、不调用外部模型。

## Comments

2026-10-11：用户确认测试接缝与六票拆分后发布。尚未开始实现或执行验收。
