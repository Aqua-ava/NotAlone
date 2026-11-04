# 旧桌面回复链路移除排除字段与勾选

Triage: ready-for-agent
State: resolved
Blocked by: 01

规格：[删除逐条消息选择与排除功能](../spec.md)。

## 目标

旧 `RewriteSnapshot`／会话链路不得再发送或渲染消息排除字段。历史载荷中的旧字段必须被明确拒绝，不能静默转成空数组。

## 范围

- `desktop/src/shared/reply-bridge.ts`。
- `desktop/src/main/reply/bridge.ts`、`client.ts`、`pasted-input.ts`、`session.ts`。
- `UnifiedReplyWorkspace`、`ReplyGenerationGuidance`。
- 相关桌面测试。

## 测试 Seam

公开边界：旧桌面回复输入合同、历史恢复和统一工作区渲染。

1. 设置更新和生成请求不接受排除字段。
2. 历史载荷含 `excluded_message_ids` 时拒绝恢复，不创建请求。
3. 统一工作区没有消息级 checkbox 或排除提示。
4. 旧候选回看仍可用。

## 验收

- 旧链路与新链路一致，不再产生排除状态。
- 历史排除载荷不会被静默扩大资料范围。
- 相关测试和类型检查通过。

## Comments

- 2026-11-04：按用户要求仅发布实现 ticket，不开始代码实现。
- 2026-11-04：按 Lead 排期先实现 03（与 01 的文件集合不重叠，可并行）；01 完成后仍须整体验收。实现中。

## Answer

- 实现：旧桌面回复合同移除 `excludedMessageIds`／`excluded_message_ids`——共享类型、IPC options 校验、生成请求正文、会话输入快照与新消息采用输入均不再产生排除字段；`pastedInputFields` 遇到历史载荷中的旧排除键时抛出「旧输入使用了已退役的消息排除设置，请重新发起请求」，历史恢复不再把旧载荷静默当作空数组。显式中断重试直接拒绝且不创建请求；已保存完成候选不恢复为可比对新输入，但仍按已保存轮次回看，并在恢复提示中给出重新发起请求的说明。`UnifiedReplyWorkspace` 最近消息改为只读展示，删除逐条 checkbox、排除提示和恢复操作，保留关系背景总开关、最近聊天查看／刷新、补充聊天与媒体面板；`ReplyGenerationGuidance` 不再比较排除集合。
- 变更文件：`desktop/src/shared/reply-bridge.ts`、`desktop/src/main/reply/{bridge,client,pasted-input,session,contact-content}.ts`、`desktop/src/renderer/{UnifiedReplyWorkspace,ReplyGenerationGuidance}.tsx`、`desktop/tests/{reply-workspace,workspace-message-adoption-client,unified-workspace-view,reply-generation-guidance}.test.mjs`。其中 `contact-content.ts` 为 ticket 写集合外的最小补充：切回联系人恢复已保存候选走同一历史恢复入口，不处理会让旧候选回看因历史排除字段失败。
- RED：先写失败回归，`cd desktop && node --test tests/reply-workspace.test.mjs tests/workspace-message-adoption-client.test.mjs tests/unified-workspace-view.test.mjs tests/reply-generation-guidance.test.mjs` 有 7 项失败（旧字段仍被接受、排除字段仍进入请求正文、历史载荷未拒绝恢复、历史完成候选被恢复成新输入、工作区仍渲染消息级 checkbox、过期判断仍比较排除集合）。
- GREEN：同一命令 29/29 通过；`cd desktop && node node_modules/typescript/bin/tsc --noEmit` 通过。相邻回归通过：`workspace-session-switch`、`workspace-local-draft`、`workspace-draft-sqlite-handoff`、`workspace-local-draft-transition`、`workspace-submission`、`history-reply-warning-view`、`sqlite-history-messages`、`sqlite-first-session-regression`（后四类 headless 以 `NOTALONE_TEST_CHROMIUM_PATH` 指向本机 Chrome 运行）以及 `contact-restore-coalescing`、`manual-confirm-session-recovery`、`reply-candidates-rejected`、`data-lifecycle`、`reply-contract`（30 项）。环境说明：按 Lead 指定用 `/tmp/notalone-node/bin` 的 Node 运行（默认 Node 因签名限制无法加载 sharp，属环境既有问题）；Playwright 浏览器缓存未安装，headless 用例改用本机 Chrome 路径。
- 风险：旧完成候选不再恢复为 `state.result`，因此不展示当次「生成输入」详情，候选经已保存轮次回看，这是「不把旧载荷静默当空数组」的保守取舍；旧排除键的拒绝同时覆盖 snake_case 与 camelCase 历史键，空数组也会被拒绝。未改 backend、当前 SQLite 工作区（C01/C02）与用户既有修改；未启动或重启 App、未做桌面交互验收。
- 复核（2026-11-04）：重跑 `reply-workspace`、`workspace-message-adoption-client`、`unified-workspace-view`、`reply-generation-guidance` 共 29/29 通过；核对共享候选装配与 Discussion 未见冲突，旧完成候选仍从已保存轮次回看、旧排除载荷拒绝恢复且不创建请求、消息列表只读。无需追加代码修改；当时 State 保持 `claimed` 等待审查，后由最终验收改为 `resolved`。
