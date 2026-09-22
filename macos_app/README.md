# NotAlone 主窗口应用

这是 NotAlone 的主窗口应用：一个 SwiftUI 三栏窗口程序，负责拉起并监管
常驻本地后端进程（`notalone-server`），通过后端 API 展示联系人列表、
CLI 后台同步状态，并提供同步开关。它不直接读取微信窗口；屏幕录制权限
只授予本应用（探针作为其子进程树中的一员运行）。CLI 后台读取微信数据时，
macOS 可能首次显示一次“访问其他 App 的数据”授权；构建脚本会把 CLI
复制到 App 内并使用稳定签名，用户允许一次后不应随每轮同步重复弹出。

权限申请、系统弹窗、稳定错误码和发布前检查的唯一维护台账见：
[macOS App 权限与启动错误记录](../docs/macos-app-permissions-and-errors.md)。

当前主窗口包含左栏联系人列表与同步开关、中栏消息流、回复/记忆/导入/Skill
工作区，以及“同步管理”页。同步管理页先列出 CLI 可见的私聊并支持用户一次
确认批量绑定；首次默认不选，可逐项勾选或主动全选当前未绑定会话，刷新不会自动选中新会话。
确认绑定并开启同步后由 CLI 在后台同步，前台 OCR 只定位当前微信联系人。页面
同时保留 Issue 04 的人工 Follow 验证和固定检查点；微信切前台、切换会话、
产生消息等动作仍由用户完成。

## 前置条件

- macOS 15 或更高版本；
- Swift 6 命令行工具与 Xcode 16.4；
- conda 环境 `NotAlone` 中已安装本项目（提供 `notalone-server` 命令）；
- 仓库根目录 `.env` 配置了 `NOTALONE_DATABASE_URL` 与 `NOTALONE_OWNER_ID`。

## 构建与运行

```bash
conda activate NotAlone
cd macos_app
swift build                 # 编译检查
zsh scripts/build_app.sh    # 构建可签名的 .app
open build/NotAloneApp.app
```

应用启动后会自动拉起后端子进程并在退出时收掉；后端不可用时会显示
清晰错误。首次出现跨 App 数据授权时，请在 NotAlone 仍处于前台时点击
“允许”；拒绝后 CLI 无法读取微信消息。打开“同步管理”页后，先刷新 CLI 私聊列表、批量确认绑定，再
开启正式同步。人工 Follow 仍需显式开始，结束验证会恢复其兜底策略；菜单栏
的 OCR 调试窗口仍保留在探针应用中。

关闭同步或退出 App 会停止读取；重新开启后的恢复只补齐仍有效的已确认绑定在 baseline 之后的可检测缺口，范围见 ADR-025/ADR-030。前台 OCR 定位失败不阻塞 CLI 后台同步。

## 边界

- 只访问 `127.0.0.1` 上的本地后端，不连接外网；
- 联系人范围由后端按 owner 隔离，本应用不做跨 owner 组装；
- 同步开关经后端 API 生效；状态按 JSON 契约轮询展示。
