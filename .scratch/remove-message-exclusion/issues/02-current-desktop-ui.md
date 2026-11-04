# 当前 SQLite 表达工作区移除逐条消息选择

Triage: ready-for-agent
State: claimed
Blocked by: 01

规格：[删除逐条消息选择与排除功能](../spec.md)。

## 目标

当前 SQLite 表达工作区保留最近聊天查看和刷新，但消息列表只读；移除逐条 checkbox、排除提示和排除状态相关请求字段。

## 范围

- `SqliteReplyCandidatesPanel` 默认值、生成参数、刷新和继续候选逻辑。
- `sqlite-reply-candidates` 共享类型与操作校验。
- 当前 SQLite 桌面测试、类型检查。
- 关系背景总开关和最近聊天查看入口保留。

## 测试 Seam

公开边界：桌面表达工作区渲染与候选 bridge 请求。

1. 最近聊天加载后没有逐条消息 checkbox。
2. 生成请求的 workspace 不含 `excludedMessageIds`。
3. 关系背景关闭时最近聊天不带入，开启时自动带入。
4. 候选继续不再因排除数组被禁用。

## 验收

- 当前窗口不再显示消息级勾选或排除提示。
- 刷新最近聊天和关系背景开关仍可用。
- 相关桌面测试和类型检查通过。

## Comments

- 2026-11-04：按用户要求仅发布实现 ticket，不开始代码实现。

## Answer

- 实现：当前 SQLite 表达工作区类型、默认值和 IPC 校验删除 `excludedMessageIds`；`carriedSelectionId` 仅受关系背景开关约束。最近聊天移除逐条 checkbox、排除提示和恢复操作，保留只读列表、刷新最近聊天与关系背景总开关；刷新仍保留未保存候选编辑，“以此版本继续”只在关系背景关闭时禁用。相关操作按钮统一复用 `.button`，生成按钮继续使用现有 `.generate-button`／`.compose-primary`。
- RED：先更新公开 IPC 契约回归，旧 `excludedMessageIds`／`excluded_message_ids` 仍被接受且缺少新合同字段被拒；`cd desktop && node --test tests/sqlite-reply-candidate-bridge.test.mjs` 显示 2 项失败（旧字段被接受、无排除字段工作区被拒绝）。
- GREEN：同一 bridge 命令 7/7 通过；用 esbuild 对 `SqliteReplyCandidatesPanel`、当前共享契约及实际 React 依赖做浏览器 bundle，输出 `bundle ok: 1242879 bytes`。当前工作树没有 `desktop/node_modules`，因此通过外部只读依赖目录与 Node ESM resolver 运行测试，未写入 `node_modules`。
- 自动化缺口：已尝试运行 `tests/sqlite-reply-candidates.test.mjs` 的只读列表用例，但 Playwright 启动本机 Chrome 时在当前沙箱内以 `SIGABRT` 结束，未进入页面断言；因此该浏览器用例只完成编译，可见工作区尚未由自动化证明。未启动或重启 App。
- 风险：关系背景关闭时列表仍可见但不会进入请求，语义由开关和 bridge 合同控制；真实 App 中的复选框消失、提示消失、只读列表及按钮状态仍需桌面验收。未改后端、旧桌面回复链路或 `SqliteMemoryManagementPanel.tsx`。
