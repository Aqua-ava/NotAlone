# 操作与排障指南

当前开发使用 TypeScript／DSH、SQLite 和 Electron。先检查 `pnpm run dev:status`，复用已有开发实例；没有实例才启动 `pnpm run dev`。完整执行规则见[工程工作流](../agents/engineering.md)。

| 当前任务 | 入口 |
| --- | --- |
| 新环境安装依赖、启动或恢复开发实例 | [新环境源码启动](new-environment-hot-start.md) → [根运行说明](../../README.md#从源码运行) |
| macOS 权限、启动错误或停读失败 | [权限与启动指南](macos-app-permissions-and-errors.md) |
| 图片整批 `media_association_unverified`、微信数据库缺密钥或重建后需补取 | [微信数据库密钥缺失与补取](wechat-db-key-refresh.md) |
| 首次连接微信、确认联系人与同步范围 | [现行微信同步](../../architecture/current/wechat-sync.md)；外置工具配置见[桌面说明](../../desktop/README.md#外置微信工具) |

历史现场仅在核查相应日期、版本或失败原因时读取：[权限与验收记录](../history/macos-permissions-history.md)、[2026-10-22 新环境记录](../history/new-environment-hot-start-20261022.md)、[2026-10-23 微信首次接入记录](../history/wechat-first-run-troubleshooting-20261023.md)。这些记录保留旧命令和当时结论，不是默认开发步骤，也不证明当前版本已验收。
