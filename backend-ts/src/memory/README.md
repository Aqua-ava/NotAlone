# 记忆模块

记忆生命周期与阶段状态见[记忆处理](../../../architecture/current/memory-processing.md)，实际输入与追踪见[执行追踪](../../../architecture/current/memory-extraction-trace.md)。这里按实现职责导航，不在子目录重复维护产品规则。

当前业务由 SQLite 模块承载，模型调用、来源核验和事务提交分开处理。

| 要处理的问题 | 从哪里开始 |
| --- | --- |
| 提取、执行回执与恢复 | [sqlite/README.md](sqlite/README.md) |
| 候选裁决、采纳与管理 | [sqlite/management/README.md](sqlite/management/README.md) |
| 场景、长期背景及发布 | [sqlite/documents/README.md](sqlite/documents/README.md) |
| 底层实例、迁移与具名事务 | [../storage/sqlite/README.md](../storage/sqlite/README.md) |

`extraction/` 提供纯提取和来源核验组件；`adoption/` 提供裁决合同及 DSH 适配。来源、规范消息、候选与确认记忆继续分层保存，并受联系人隔离和统一删除约束。

源码路径调整会产生新指纹；旧任务和质量证据按原版本核验，不伪装成旧实现继续执行。
