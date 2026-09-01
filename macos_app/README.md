# NotAlone 主窗口应用

这是 NotAlone 的主窗口应用：一个 SwiftUI 三栏窗口程序，负责拉起并监管
常驻本地后端进程（`notalone-server`），通过后端 API 展示联系人列表、
CLI 后台同步状态，并提供同步开关。它不直接读取微信窗口；屏幕录制权限
只授予本应用（探针作为其子进程树中的一员运行）。

当前主窗口包含左栏联系人列表与同步开关、中栏消息流、回复/记忆/导入/Skill
工作区，以及“同步管理”页。同步管理页先列出 CLI 可见的私聊并支持用户一次
确认批量绑定；确认后由 CLI 在后台同步，前台 OCR 只定位当前微信联系人。页面
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
清晰错误。打开“同步管理”页后，先刷新 CLI 私聊列表、批量确认绑定，再
开启正式同步。人工 Follow 仍需显式开始，结束验证会恢复其兜底策略；菜单栏
的 OCR 调试窗口仍保留在探针应用中。

## 边界

- 只访问 `127.0.0.1` 上的本地后端，不连接外网；
- 联系人范围由后端按 owner 隔离，本应用不做跨 owner 组装；
- 同步开关经后端 API 生效；状态按 JSON 契约轮询展示。
