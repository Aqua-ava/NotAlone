# 记忆模块

当前业务由 SQLite 模块承载，模型调用、来源核验和事务提交分开处理。

| 要处理的问题 | 从哪里开始 |
| --- | --- |
| 提取、执行回执与恢复 | [sqlite/README.md](sqlite/README.md) |
| 候选裁决、采纳与管理 | [sqlite/management/README.md](sqlite/management/README.md) |
| 场景、长期背景及发布 | [sqlite/documents/README.md](sqlite/documents/README.md) |
| 底层实例、迁移与具名事务 | [../storage/sqlite/README.md](../storage/sqlite/README.md) |

`extraction/` 保留被当前 SQLite 流程使用的纯提取和来源核验组件；`adoption/` 保留裁决合同及 DSH 适配。旧 PostgreSQL service/store/worker 已退役，旧统一处理合同和执行记录仅供历史追溯，不代表当前开放路由。来源、规范消息、候选与确认记忆继续分层保存，并受联系人隔离和统一删除约束。

源码路径调整会产生新指纹；旧任务和质量证据按原版本核验，不伪装成旧实现继续执行。
