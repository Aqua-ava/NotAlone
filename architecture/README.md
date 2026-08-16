# NotAlone 架构文档

> 状态：已建立。本目录区分现行约束、设计草案与 ADR；文档不代表对应功能已经实现。

## 文档分层

| 位置 | 唯一职责 |
| --- | --- |
| [`CONTEXT.md`](../CONTEXT.md) | 统一领域词汇，只定义概念。 |
| [`current/`](current/) | 已采纳、当前实现必须遵守的规格。 |
| [`drafts/`](drafts/) | 尚未全部确认或实现的设计，不作为现行约束。 |
| [`adr/`](adr/) | 难以逆转且存在真实取舍的架构决策及原因。 |
| [`.scratch/`](../.scratch/) | 功能规格和可执行任务，不在架构文档中积累待办。 |

已完成的评审过程不保留为当前架构文档；Git 历史负责保存旧版本。实际行为以代码和测试为准，不能用架构文档证明功能已经实现。

## 按任务阅读

1. 先读根目录 [`CONTEXT.md`](../CONTEXT.md)，使用统一领域语言。
2. 按任务读取一份或多份现行规格：[`domain-data.md`](current/domain-data.md)、[`core-flows.md`](current/core-flows.md)、[`privacy-deletion.md`](current/privacy-deletion.md)。
3. 只有涉及云端部署、回复运行时或真实表达质量时，才读取对应草案：[`cloud-engineering.md`](drafts/cloud-engineering.md)、[`agent-runtime.md`](drafts/agent-runtime.md)、[`authentic-expression.md`](drafts/authentic-expression.md)。
4. 当现行规格或草案引用 ADR 时，再读取对应决策；复审既有决定时必须新增 ADR 修订或替代，不能覆盖历史原因。
5. 整体关系可查看 [NotAlone 架构图](notalone-system-architecture.drawio)；架构图同样不代表运行时验证。

## ADR 索引

1. [ADR-001：Mac 微信前台会话同步](adr/001-macos-wechat-active-session-sync.md)
2. [ADR-002：关系提取与全自动采纳](adr/002-relationship-extraction-and-tiered-adoption.md)
3. [ADR-003：Mac 同步连续性与用户补录](adr/003-macos-sync-continuity-and-backfill.md)
4. [ADR-004：用户自行导出的微信单联系人历史文件](adr/004-user-managed-wechat-history-export.md)
5. [ADR-005：可解释检索与联系人知识视图](adr/005-explainable-retrieval-and-contact-knowledge-view.md)
6. [ADR-006：Agent 编排与检索框架边界](adr/006-agent-orchestration-and-retrieval-frameworks.md)
7. [ADR-007：后台任务步骤与 Worker 执行边界](adr/007-background-task-steps-and-worker.md)
8. [ADR-008：联系人身份与渠道身份分离](adr/008-separate-contact-and-channel-identity.md)

## 当前架构决策

- 采用云端模块化单体，PostgreSQL 是联系人、消息、关系资料、任务和删除状态的权威业务库。
- 数据隔离键为 `owner_id + contact_id`；`contact_id` 由 NotAlone 创建，昵称、备注和微信来源标识不能替代它。
- 文字是统一的检索与生成表示；截图、语音和前台画面是输入适配器。
- 生成只使用已选联系人下的有界上下文；模型提取的记忆必须带来源、标记 `auto` 且可撤销。
- 候选回复只在应用内展示，最终由用户修改并亲自发送。

## 状态规则

- `已采纳`：放入 `current/` 或记录为已采纳 ADR，可作为实现与测试约束。
- `草案`：放入 `drafts/`，用于探索尚未完全确认的实现设计。
- `已废弃`：由替代 ADR 保留历史原因；从当前阅读路径移除。

新术语写入 `CONTEXT.md`，重要取舍写入 `adr/`，未决设计写入 `drafts/`，代码整改写入 `.scratch/`。每个含义只保留一个权威位置。
