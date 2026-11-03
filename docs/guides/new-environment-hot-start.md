# 新环境源码启动

现行源码开发使用 macOS、Node.js ≥ 24、pnpm 11.25.0 和本机 SQLite；原生组件开发需要 Xcode／Swift。依赖版本以根 [package.json](../../package.json) 与锁文件为准，安装要求及模型配置见[根运行说明](../../README.md#从源码运行)。

## 安装与启动

在仓库根目录安装锁定依赖：

```bash
pnpm install --frozen-lockfile
pnpm run dev:status
```

`dev:status` 返回 `development` 时复用该实例，保存源码即可更新；返回 `stopped` 且退出码为 1 表示没有当前开发实例。出现身份冲突或其他错误时，先按[工程工作流](../agents/engineering.md)核对实际进程，不直接再开一份。

没有已有实例时，日常启动命令是：

```bash
pnpm run dev
```

开发监督器负责 React／CSS 热更新及主进程、preload、后台源码变化后的安全重启。启动后再查 `pnpm run dev:status`，并在界面核对本机服务状态；进程存活不代表服务已就绪。Agent 启动常驻进程时按工程工作流放到后台并有界等待，不让工具调用一直占用前台。

## 启动失败时

- 当前 SQLite 不要求安装或启动 PostgreSQL，也不要求激活 Python／Conda。保留已有配置和资料目录，不以新空库、删除锁文件或重新安装旧栈解决状态异常。
- 缺依赖或原生组件时，核对当前锁文件、真实脚本及相应错误。连接、存储和停读错误按[权限与启动指南](macos-app-permissions-and-errors.md)处理；密钥及配置正文不进入诊断记录。
- 开发入口不接受 `--host`／`--port`；需要隔离数据目录时只用脚本支持的 `--user-data-dir /绝对路径`，并用相同目录查询状态。已有数据的选择与恢复不能由随意换目录代替。
- 日常排障继续使用开发实例。打包、旧包运行、签名与发布仅在用户明确发起的发布任务中处理，不能为启动或权限问题自行解除发布门禁。

## 历史现场

[2026-10-22 全新环境热启动记录](../history/new-environment-hot-start-20261022.md)完整保留当时工具链、下载、Python／PostgreSQL、握手和会话回收问题及实际结果。该记录中的“最终可用启动方式”和命令仅适用于当时版本，不用于当前安装。
