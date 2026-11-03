# 后台源码入口

当前后台由 SQLite 宿主装配；业务源码按职责归组，测试位于 [`../test/`](../test/)。

## 启动与装配

正式入口为 [launch.ts](launch.ts) 与 [sqlite-host-plugin.ts](sqlite-host-plugin.ts)，使用 [`profile/sqlite.patch.yml`](../profile/sqlite.patch.yml)。宿主装配位于 [host/](host/)，存储迁移与具名事务统一注册在 [storage/sqlite/registry.ts](storage/sqlite/registry.ts)。

## 按业务查找

| 职责 | 目录 |
| --- | --- |
| 联系人、稳定身份与绑定 | [contacts/sqlite/](contacts/sqlite/) |
| 历史消息、来源连续性与增量同步 | [history/sqlite/](history/sqlite/README.md) |
| 记忆提取及执行 | [memory/sqlite/](memory/sqlite/) |
| 记忆裁决与管理 | [memory/sqlite/management/](memory/sqlite/management/) |
| 文档、来源与发布 | [memory/sqlite/documents/](memory/sqlite/documents/) |
| 候选回复、讨论与生成运行时 | [reply/sqlite/](reply/sqlite/) |
| Skill 注册与执行 | [skills/sqlite/](skills/sqlite/) |
| 媒体资料与处理状态 | [media/sqlite/](media/sqlite/) |
| 微信外置工具适配及前台定位 | [sync/](sync/)、[foreground/](foreground/) |
| 存储、事务与统一删除 | [storage/sqlite/](storage/sqlite/) |
| 模型调用、切换与进程支持 | [platform/](platform/) |

目录存在不代表入口已开放。当前装配由 `sqlite-host-plugin.ts` 的 ownership 与运行能力报告确定；模块合成测试、正常 profile 接线、实际 App 和真实模型质量分别验证。产品流程从[现行架构](../../architecture/README.md)进入。
