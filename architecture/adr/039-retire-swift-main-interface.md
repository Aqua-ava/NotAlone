# ADR-039：退役 Swift 主界面，重新设计共享前端

> 2026-10-21 设计审查：“React 未实现／desktop 仅职责说明”是决定当日状态；后继桌面宿主见 [ADR-040](040-electron-dual-window-host.md)，本机运行时与原库更新见 [ADR-061](061-standalone-local-app-onboarding-and-updates.md)、[ADR-066](066-in-place-schema-updates-and-database-reuse.md)。Swift 主界面退役与 Python／原生探针职责保留；这些后继不证明 Windows 或最终分发已验收。

> 状态：已采纳
> 决策日期：2026-10-08

用户确定未来支持 Mac 与 Windows，选择 TypeScript + React 共用界面，并要求先删除旧 Swift 主界面，再另行设计新 UI。删除 `macos_app/` 的视图、展示状态、桌面客户端、监管器、构建与对应测试；本轮不创建替代界面或脚手架，桌面宿主与新 UI 后续实现。

本决策局部修订 ADR-020 的 SwiftUI 宿主和 ADR-021 的 Swift 主界面构建／首启向导入口，其余本地认证 HTTP + SSE、单后端、联系人隔离、人工发送、外置 Python/PostgreSQL 和无自动更新边界保留。Python 后台、数据库与迁移继续复用；`macos_sync_probe/` 保留 Swift 原生截图、OCR、定位与独立调试入口。清理后主窗口和图形首启向导暂不可用，CLI 仍保留；React 与 Windows 集成尚未实现。

后续目录整理（2026-10-08）：Python 项目位于 `backend/`，原 `macos_sync_probe/` 位于 `native/macos/`，`desktop/` 仅有后续职责说明；决策边界不变，当前工程入口见 [仓库说明](../../README.md)。
