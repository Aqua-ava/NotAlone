# 全新环境热启动记录

> 历史实测记录：下文保留当时版本的环境、命令与结果，其中 Python／Conda／PostgreSQL 步骤不是当前启动指南。现行 TypeScript／DSH／SQLite 入口以[项目 README](../../README.md#从源码运行)与[后台说明](../../backend-ts/README.md)为准；历史成功不代表当前版本已重新验收。

记录日期：2026-10-22  
记录范围：在全新 macOS 环境中从源码启动 NotAlone 桌面开发实例。  
当前状态：热更新实例已启动，App 已通过本机后端连接；本人身份与模型尚未初始化。

## 结果摘要

本轮最终确认：

- `npm run dev:status` 返回 `{"mode":"development","pids":[18197]}`。
- Electron 开发宿主 PID 为 18197，Python 后端 PID 为 18290。
- `GET /api/runtime/status` 返回 `{"state":"running"}`。
- App 管理后台实际显示“已连接”。
- 当前停在“本次运行的本人身份未就绪”，需要用户填写本人展示名称和模型密钥后初始化；本轮没有伪造身份或保存模型凭据。

本地工具链与数据位置：

| 项目 | 路径或版本 |
| --- | --- |
| Conda | `$HOME/miniconda3`，26.9.3 |
| `NotAlone` 环境 | `$HOME/miniconda3/envs/NotAlone` |
| Python | 3.12.15 |
| Node.js | 22.23.4 |
| npm | 10.9.9 |
| PostgreSQL | 16.15 |
| 开发数据库 | `notalone_dev` |
| PostgreSQL 数据目录 | `$HOME/.local/share/NotAlone/postgres` |
| Desktop userData | `$HOME/Library/Application Support/NotAloneDesktop` |
| 后端握手文件 | `$HOME/.notalone/backend.info` |
| 原生探针 | `native/macos/build/cli/notalone-sync-probe` |

## 环境基线

- 仓库：`~/Documents/learn/NotAlone`
- 系统：macOS 27.0，arm64
- Git：`/usr/bin/git`
- Swift：`/usr/bin/swift`（Swift 6.4）
- Xcode Command Line Tools：已安装，`xcrun clang` 可用
- 初始磁盘可用空间：约 170 GiB，高于仓库要求的 15 GiB
- 初始仓库状态：干净；`desktop/node_modules`、Conda 环境和 `.env` 均不存在
- 微信桌面版：已安装并正在运行

## 遇到的问题

### 1. 当前 shell 缺少全部源码开发工具

登录 shell 的 `PATH` 中找不到：

- Node.js / npm
- Python 3.12 / Conda
- PostgreSQL
- Homebrew

首次执行 `npm run dev:status` 时的原始错误：

```text
zsh:1: command not found: npm
```

影响：无法检查已有开发实例，也无法准备桌面依赖。

处理：在用户目录安装 Miniconda，并在 `NotAlone` 环境内安装 Python 3.12、Node.js 22 和 PostgreSQL 16。

### 2. 一键安装脚本不能从零引导当前机器

`scripts/install.sh` 假定 Homebrew 已由用户预先安装，并在检查到缺失时立即退出。它还会假定 Conda 已安装；只有 PostgreSQL 缺失时才尝试通过 Homebrew 安装。

影响：README 的“源码运行”命令链不能直接用于没有 Homebrew 和 Conda 的机器，需要先手工准备前置工具。

本轮处理：没有改写产品安装脚本，采用等价的用户级命令完成后端依赖、数据库、迁移和原生探针准备。是否扩展安装脚本属于后续产品化问题。

### 3. 系统 Python 版本不满足后端要求

系统自带 `/usr/bin/python3` 为 Python 3.9.6，而 `backend/pyproject.toml` 要求 `>=3.12,<3.13`。

影响：不能直接使用系统 Python 安装或运行后端。

处理：创建独立的 `NotAlone` Conda 环境，实际使用 Python 3.12.15。

### 4. Conda 默认频道服务条款阻止环境创建

首次执行 Conda 环境创建时，Conda 26 报告 `CondaToSNonInteractiveError`，要求接受 `repo.anaconda.com` 默认频道的服务条款。

原始错误要点：

```text
Terms of Service have not been accepted for the following channels:
- https://repo.anaconda.com/pkgs/main
- https://repo.anaconda.com/pkgs/r
```

处理：没有代替用户接受 Anaconda 条款，改用 `--override-channels -c conda-forge` 创建纯 `conda-forge` 环境。

### 5. Electron 官方下载地址连接超时

`npm ci` 成功后，Electron 只有 npm 包外壳，没有下载运行所需的二进制。首次执行 `npx install-electron` 出现：

```text
TypeError: fetch failed
```

直接访问 GitHub 的 Electron 44.7.0 release 也在 30 秒后超时。`npmmirror.com` 的对应 44.7.0 arm64 文件可访问。

处理：设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重新执行 `npx install-electron`。安装成功，运行文件位于：

```text
desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
```

### 6. 当前工具执行层会回收后台进程

按工程文档使用 `nohup npm run dev ... & disown` 启动后，监督器一度打印“开发模式”，但命令调用结束时整个进程组被回收，`dev:status` 随即显示 `stopped`。

为排除项目脚本自身问题，另外启动了一个不依赖项目的 `nohup sleep 45 & disown` 对照进程；它同样在命令结束时消失，确认这是本轮工具执行环境的后台回收行为。

处理：使用持久 PTY 会话托管单一 `npm run dev`，不再用已经返回的普通命令会话承载常驻进程。

### 7. 被回收的监督器留下 Unix socket

后台监督器被回收后，临时目录保留了开发租约 socket：

```text
$TMPDIR/notalone-dev-6dc798121321acc6cd7d74a1.sock
```

下一次启动尝试连接该 socket 时出现：

```text
Error: connect ECONNREFUSED
```

处理：先确认 `dev:status` 为 `stopped`、`lsof` 无持有者，再删除这个精确路径下的本轮残留 socket。没有终止未知进程，也没有删除其他锁文件。

### 8. Desktop userData 目录与展示名称不同

开发宿主实际使用：

```text
~/Library/Application Support/NotAloneDesktop
```

而不是容易从产品名推断出的：

```text
~/Library/Application Support/NotAlone
```

影响：把 `backend-launch.json` 放到后者时，App 正确显示“尚未配置本机启动路径”。

处理：将非秘密启动配置放到实际 userData 目录，并将权限设为 `0600`。后续文档或排障说明宜明确这一路径。

### 9. 全新用户没有后端握手目录

配置启动路径后，App 首次诊断显示“后端握手文件路径不可用”。默认握手文件是 `~/.notalone/backend.info`，但全新机器没有父目录 `~/.notalone`。

处理：创建权限为 `0700` 的 `~/.notalone` 目录，再点击“重试连接”。后端启动后生成了权限为 `0600` 的握手文件。

### 10. Electron 输出 sandbox extension 警告

开发 App 就绪后，终端输出：

```text
sandbox_extension_issue_file failed ... Operation not permitted
```

影响：本轮没有阻断 App 启动、页面渲染或后端连接，但原因和 macOS 27 下的长期影响尚未查清。

后续处理：继续观察是否影响文件选择、剪贴板、原生探针或权限相关场景；在定位前不把它宣称为无害。

### 11. 本人身份与模型仍未初始化

后端和 App 已连接，但空数据库没有本人身份，根 `.env` 也没有 DeepSeek API Key。

影响：当前可以展示联系人、设置和连接状态，但不能完成真实模型生成流程。

处理：保留用户输入边界。需要用户在 App 的“本人身份与模型”中填写本人展示名称和自己的密钥后完成初始化；本轮没有把开发占位名称写入业务库。

### 12. Git 没有配置提交身份

首次本地提交出现：

```text
Author identity unknown
fatal: unable to auto-detect email address
```

影响：仓库无法自动创建本任务的本地提交。

处理：没有改写用户的全局 Git 配置；本次提交临时使用 Codex 专用作者信息。如需要归属到个人身份，可在确认后自行修正该提交作者。

## 已完成的准备与验证

| 检查 | 结果 |
| --- | --- |
| `python -m pip install -e ./backend` | 成功 |
| `cd desktop && npm ci` | 成功，83 个包，0 个漏洞 |
| `cd desktop && npm run typecheck` | 成功 |
| PostgreSQL 初始化与启动 | 成功，`pg_isready` 返回 accepting connections |
| 数据库迁移 | 成功，实际应用 001–103 共 103 个版本 |
| `notalone.startup_diagnostics` | 返回 `{"code":"ready"}` |
| 原生探针构建 | 成功，产出 sync probe 与 header change source |
| Electron 44.7 运行时 | 成功准备 |
| `npm run dev:status` | 成功，返回 `development` 与宿主 PID |
| `/api/runtime/status` | `running` |
| Computer Use 实际 App 检查 | 管理后台显示“已连接” |

## 本轮数据处理与边界

- 根 `.env` 只写入本地数据库连接，权限为 `0600`，且被 Git 忽略。
- 没有写入模型密钥、本人身份、联系人、聊天正文或记忆。
- 没有读取微信正文、上传截图或发送外部消息。
- PostgreSQL 开发库和 Conda 环境均为当前用户私有目录。
- 原生探针只完成构建，没有执行屏幕采集。

## 重新启动时

先确认 PostgreSQL 和开发实例状态：

```bash
export PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH"
pg_isready -h 127.0.0.1 -p 5432
cd desktop
pnpm run dev:status
```

如果状态为 `stopped`，按[工程工作流](../agents/engineering.md)启动 `pnpm run dev`。如果状态为 `development`，复用现有实例，不启动第二份。若实例被非正常回收并留下 socket，先确认没有存活宿主和持有者，再清理对应租约。

## 剩余风险

- Electron sandbox extension 警告尚未定位。
- 尚未填写本人身份和模型密钥，未验证真实模型生成。
- 尚未配置外置微信 CLI/WCDB，未验证真实微信增量同步。
- 未执行 HMR 实际修改测试；只确认热更新监督器与开发宿主已就绪。
- 安装脚本仍不能在缺少 Homebrew/Conda 的全新机器上自行完成引导。

