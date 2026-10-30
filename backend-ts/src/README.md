# 后台源码入口

当前后台由 SQLite 宿主装配；业务源码按职责归组，测试位于 [`../test/`](../test/)。

## 启动与装配

正式入口为 [launch.ts](launch.ts) 与 [sqlite-host-plugin.ts](sqlite-host-plugin.ts)，使用 [`profile/sqlite.patch.yml`](../profile/sqlite.patch.yml)。宿主装配位于 [host/](host/)，存储迁移与具名事务统一注册在 [storage/sqlite/registry.ts](storage/sqlite/registry.ts)。

## 按业务查找

| 职责 | 目录 |
| --- | --- |
| 联系人、稳定身份与绑定 | [contacts/sqlite/](contacts/sqlite/) |
| 历史导入、来源连续性与增量同步 | [history/sqlite/](history/sqlite/) |
| 记忆提取及执行 | [memory/sqlite/](memory/sqlite/) |
| 记忆裁决与管理 | [memory/sqlite/management/](memory/sqlite/management/) |
| 文档、来源与发布 | [memory/sqlite/documents/](memory/sqlite/documents/) |
| 候选回复、讨论与生成运行时 | [reply/sqlite/](reply/sqlite/) |
| Skill 注册与执行 | [skills/sqlite/](skills/sqlite/) |
| 媒体资料与处理状态 | [media/sqlite/](media/sqlite/) |
| 微信外置工具适配及前台定位 | [sync/](sync/)、[foreground/](foreground/) |
| 存储、事务与统一删除 | [storage/sqlite/](storage/sqlite/) |
| 模型调用、切换与进程支持 | [platform/](platform/) |

目录存在不代表所有功能已开放；能力以 SQLite 宿主的 ownership 和实际端到端验证为准。13 表达偏好、15 纠错诊断、18 语音保存转换和 19 真实媒体验收仍按原范围暂缓。
