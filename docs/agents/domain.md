# 领域文档

本仓库采用 single-context 布局；以下路径均相对仓库根目录，表中的规格路径相对 `architecture/`。

## 开始探索前

先读 [架构索引](../../architecture/README.md)，再按任务分支读取；ADR 路径以索引为准。完成条件：所有受影响的已采纳约束和 ADR 均已核对。

| 任务分支 | 必读材料 |
| --- | --- |
| 联系人、消息、来源、记忆或检索 | `current/domain-data.md`；涉及自动采纳或检索时再读 ADR-002/ADR-005 |
| 导入、回复、删除或后台任务 | `current/core-flows.md`；涉及历史导入或 Worker 时再读 ADR-004/ADR-007 |
| Mac 微信同步、OCR 或连续性 | `current/core-flows.md`、`current/privacy-deletion.md`、ADR-023、ADR-025、ADR-030；追溯旧视觉方案时再读 ADR-001、ADR-003 |
| 隐私、外部模型、云端存储、连接器或部署 | `current/privacy-deletion.md`、`drafts/cloud-engineering.md` 及相关 ADR |
| Agent、Tool、MCP、RAG 或编排框架 | `drafts/agent-runtime.md`、ADR-006、ADR-009 |

根目录 `CONTEXT.md` 存在时也要读取；缺失时继续任务，只在领域术语需要正式整理时使用 `domain-modeling` 创建。输出沿用其中已定义的名称；未定义的概念先判断是错误同义词，还是需通过 `domain-modeling` 补充的真实领域缺口。

## 记录路由

- 新的领域术语写入根目录 `CONTEXT.md`，不包含实现细节。
- 已采纳且当前实现必须遵守的规格写入 `architecture/current/`。
- 尚未完全确认的实现设计写入 `architecture/drafts/`。
- 难以逆转、原因不显然且存在真实取舍的决定写入 `architecture/adr/`。
- 功能规格和代码整改按 [任务约定](issue-tracker.md) 写入 `.scratch/<feature-slug>/`；完成的评审过程由 Git 历史保存，不作为当前架构文档保留。

## 文档权威边界

- `AGENTS.md` 中的产品范围、隐私和人工发送约束是当前最高优先级规则。
- `architecture/` 是设计记录，不保证方案正确或已实现；已实现行为按根 `AGENTS.md` 的运行证据规则核验。
- 标记为“草案”的内容只用于理解探索方向，不得当作实现约束。
- 标记为“已采纳”的 ADR 是当前阶段性决定；新证据表明其不合适时，明确提出复审，通过新 ADR 修订或替代。提议与现有 ADR 冲突时必须明确指出，不得静默覆盖：

> 与 ADR-XXX 冲突；重新讨论的原因是……
