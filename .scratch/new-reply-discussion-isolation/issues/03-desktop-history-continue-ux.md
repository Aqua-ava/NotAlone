# 桌面历史讨论回看与继续交互

Triage: ready-for-agent
State: claimed
Blocked by: 02

## 目标

让用户清楚区分历史讨论“只是回看”和“已经继续使用”，并确保历史讨论不会让用户误以为已加入新候选。

## 范围

- 历史讨论区域标注：仅回看，不会自动加入新候选。
- 点击历史条目进入只读回看状态；只有“继续此讨论”按钮改变当前讨论。
- 当前讨论与历史讨论显示可区分状态。
- 回看、继续、新候选三个入口不得互相触发。
- 保留讨论删除入口，并明确删除范围：删除助手讨论和候选痕迹，不删除原始聊天、关系记忆或本人记忆。
- 不新增历史讨论作为关系背景选项。

## 测试 Seam

公开边界：桌面表达工作区与助手讨论页面。

1. 打开历史讨论后，候选按钮、请求状态和当前讨论标识不变。
2. “继续此讨论”后，仅当前讨论状态变化，不自动生成候选。
3. 点击候选动作不会读取或切换历史讨论。
4. 切换联系人后，历史讨论和当前讨论状态按联系人隔离。
5. 删除确认文案覆盖实际删除范围。

## 验收

- 用户能从界面明确知道历史讨论不会被自动使用。
- 回看不会改变当前讨论或触发模型。
- 只有明确继续后才进入可提交的当前讨论。
- 实际开发 App 完成桌面验收；构建或自动化测试不能单独证明交互通过。

## 不在范围

- 重做助手讨论整体视觉设计。
- 自动发送任何外部消息。
- 修改 Skill、最近聊天或关系资料入口。

## Comments

- 2026-11-04 冲突：Remove Exclusion 工作树已修改 `desktop/tests/sqlite-reply-candidates.test.mjs`；本票把按钮改为“删除正在查看的讨论”“刷新讨论列表”后，该测试中的旧选择器也需要同步。为避免跨工作树强改，共享测试文件保持未修改，留给主会话集成时适配；其余 UI、状态和删除确认测试不涉及该冲突文件。

## Answer

- 历史折叠区固定显示“仅回看，不会自动加入新候选”；SQLite 讨论区按目录状态显示“当前讨论：后续助手讨论会使用这段内容”或“历史讨论仅回看，不会自动加入新候选；继续此讨论后才切换当前讨论”。
- 目录项区分“当前讨论”“历史讨论 · 仅回看”“正在回看”，查看按钮带 `aria-pressed`。只有历史项提供“继续此讨论”；当前项仅在真实 `resume_required` 或目录失败时保留明确重试入口。候选动作回归另行断言不会读取历史正文或调用 continue。
- 操作按钮复用 `.button`；新增状态徽标和只读提示只使用 `--button-*`、`--panel-*` 既有变量，未新增第二套按钮样式或历史讨论背景选项。
- 删除确认抽成 `AssistantSessionDeletionConfirmation`，明确删除讨论、候选版本和运行使用痕迹，保留联系人、原始微信聊天、关系记忆和本人记忆；确认和取消按钮均复用 `.button`。
- RED：新增 SSR UI 测试在实现前因缺少“仅回看，不会自动加入新候选”失败；删除确认测试先因公开组件不存在而构建失败。GREEN 后 `assistant-history-layout.test.mjs` 4/4。
- 验证明细：通过临时依赖布局执行当前源与测试，未修改任何 `node_modules`；`assistant-history-layout`、`workspace-session-switch`、`sqlite-discussion-session`、`assistant-idle-rollover`、`assistant-session-catalog`、`assistant-session-deletion-guards`、`assistant-session-catalog-read` 合计 34/34 通过。
- 未执行：本机 Playwright/Electron 实际界面验收需要监听端口和启动 App，本会话沙箱禁止监听且用户明确禁止启动 App；现有 `sqlite-discussion-panel.test.mjs` 已完成按钮文案适配但未运行。Remove Exclusion 冲突见上，合并时需同步其共享测试选择器。
- State 保持 `claimed`，等待主会话独立审查与集成。

- 2026-11-04 集成校正：`sqlite-discussion-panel` 原断言仍假设历史正文在默认折叠时可见、preload 只有 `submit/onInvalidated`，与“历史仅回看、显式继续”和受控候选端口集成后的现行合同不一致。RED 为 61/63；将测试改为先确认历史发言不在默认可访问树、展开“与助手讨论”后才可回看，目录仍要求显式“继续此讨论”，并允许 preload 固定 `candidates` 端口；GREEN 63/63。没有放宽拒绝额外字段、来源失效、迟到回包或候选操作白名单断言。

- 2026-11-04 Standards P2 修复：`AssistantSessionPanel` 原先声明但未解构/透传 `onInitialDraftTaken`，候选面板也未调用，联系人级草稿在切换讨论或重新挂载后可能再次注入。现由会话面板透传到 `SqliteReplyCandidatesPanel`，仅在首次成功播种当前 scope 的初始草稿后调用一次；用户已编辑时 `seeded.current` 阻止旧草稿覆盖。新增实际浏览器回归覆盖首次注入、用户编辑保留、切换讨论不重复；讨论面板 3/3、草稿交接 5/5、桌面 typecheck 通过。

- 2026-11-04 Spec 复审补充：同步 React 状态的回归未覆盖真实异步草稿清空；若 `setDraft('')` IPC 返回前切换讨论，含 sessionId 的 scopeKey 会再次播种旧草稿。RED 在延迟清空夹具下复现为切换后文本仍为旧草稿。现用 `contactId + scopeRevision + initialDraft` 记录已消费交接，并在草稿清空后释放记录，不再以 sessionId 判重；同一延迟清空回归 GREEN。扩大桌面回归 69/69，typecheck 通过。
