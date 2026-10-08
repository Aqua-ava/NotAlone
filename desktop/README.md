# 桌面端

后续使用 TypeScript + React 重新设计 UI，面向 macOS 与 Windows。本轮只整理工程边界，尚无 `package.json`、依赖、界面或可运行的桌面宿主。

确定桌面宿主并开始实现后，目录按职责划分：

| 目录 | 职责 |
| --- | --- |
| `src/main/` | 桌面进程生命周期、窗口及 Python 后台的启动与关闭 |
| `src/preload/` | Electron 宿主下受限的系统能力桥接 |
| `src/renderer/` | React 界面、交互与展示状态 |

`main/preload/renderer` 是 Electron 的目录分工；若选用其他宿主，应按实际运行模型调整。TypeScript + React 的选择不代表本轮已实现或锁定宿主。

联系人、导入、数据库、记忆、检索及候选生成由 [Python 后端](../backend/README.md)提供。平台原生截图、OCR 与会话定位由 [Mac 原生探针](../native/macos/README.md)提供，Windows 平台适配尚未实现。

新 UI 须继续遵守 [产品边界](../CONTEXT.md)：用户确认联系人与读取范围、查看并编辑候选、亲自发送；桌面退出必须停止本次后台读取。原主界面已退役，后续设计不复刻旧界面，见 [ADR-036](../architecture/adr/036-retire-swift-main-interface.md)。
