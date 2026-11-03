# 历史开发与操作记录

本目录保留已被替代的开发步骤、日期实测和阶段实现记录，只在追溯具体版本时读取。历史中的命令、测试数量、权限操作、能力状态和授权均属于当时范围，不能作为当前操作要求或验收结论。

日常运行从[项目 README](../../README.md)和[当前操作指南](../guides/README.md)进入；设计规则从[现行规格入口](../../architecture/README.md)进入。旧领域协议另见[架构历史目录](../../architecture/history/README.md)，评测协议与冻结证据见[评测索引](../evaluations/README.md)。

| 历史记录 | 当前入口 |
| --- | --- |
| [桌面、原型与原生模块阶段记录](desktop-development-history.md) | [桌面说明](../../desktop/README.md)、[测试入口](../../desktop/tests/README.md)、各原生模块 README |
| [后台阶段实现记录](backend-development-history.md) | [后台说明](../../backend-ts/README.md)、[模块导航](../../backend-ts/src/README.md) |
| [macOS 权限与启动历次记录](macos-permissions-history.md) | [权限与排障](../guides/macos-app-permissions-and-errors.md) |
| [2026-10-22 环境热启动记录](new-environment-hot-start-20261022.md) | [新环境源码启动](../guides/new-environment-hot-start.md) |
| [2026-10-23 微信首次初始化记录](wechat-first-run-troubleshooting-20261023.md) | [当前微信连接与读取边界](../../architecture/current/wechat-sync.md)、[数据访问排障](../guides/macos-app-permissions-and-errors.md#微信应用数据访问) |

归档保留原决定、失败、限制和当时证据；只修正移动后的相对链接与行尾格式（Markdown 换行改为等价的 `<br>`）。明确失效的源码路径保留为历史标识，必要时从对应 Git 版本追溯。带内容摘要或被冻结脚本读取的证据不迁移、不改写，以现行索引说明其历史地位。
