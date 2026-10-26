# 操作与排障记录

当前启动步骤见[项目 README](../../README.md#从源码运行)和[桌面端说明](../../desktop/README.md)，开发约束见[工程工作流](../agents/engineering.md)。日常开发使用 `npm run dev`，先核验并复用已有实例。

| 问题 | 记录 |
| --- | --- |
| macOS 权限、签名归属、原生探针或启动错误 | [macOS App 权限与启动错误记录](macos-app-permissions-and-errors.md)；按日期查对应版本的现象与验收范围 |
| 全新环境启动遇到的工具链、下载或握手问题 | [2026-10-22 全新环境热启动记录](new-environment-hot-start.md)；其中 Python/Conda 步骤属于当时实现，当前后台以 TypeScript 说明为准 |

这些记录保留实际发生的问题和验证结果，历史成功记录不代表当前版本已通过相同验收。
