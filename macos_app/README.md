# NotAlone 主窗口应用

这是 NotAlone 的主窗口应用：一个 SwiftUI 三栏窗口程序，负责拉起并监管
常驻本地后端进程（`notalone-server`），通过后端 API 展示联系人列表与
前台同步状态，并提供同步开关。它不直接读取微信窗口；屏幕录制权限
只授予本应用（探针作为其子进程树中的一员运行）。

本次交付为第一批骨架：左栏联系人列表与同步开关；中栏消息流与右栏
回复工作区为后续版本占位。

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
清晰错误。菜单栏的 OCR 调试窗口仍保留在探针应用中。

## 边界

- 只访问 `127.0.0.1` 上的本地后端，不连接外网；
- 联系人范围由后端按 owner 隔离，本应用不做跨 owner 组装；
- 同步开关经后端 API 生效；状态按 JSON 契约轮询展示。