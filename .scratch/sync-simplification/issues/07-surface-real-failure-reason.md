# 回复面板：围栏时直接告知真实原因，不显示“尚未找到原请求”

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: none

起因：生成回复被来源围栏拒绝（`discussion_source_unavailable`）时，面板随后核对该请求状态得到 `not_found`，把真实报错覆盖成“尚未找到原请求，请稍后核对。”（`desktop/src/renderer/SqliteReplyCandidatesPanel.tsx` 约 126-130 行的 catch 后 `showStatus`，`statusFailure` 对 `not_found` 的文案）。

## 要做

- 生成请求本身已报错且该请求未落库（`not_found`）时，保留并显示真实原因，不被覆盖；围栏相关错误用面向用户的中文说明（聊天来源待重新核验，提供“处理同步问题”入口）。
- 仅在请求可能已受理但状态读取失败时才使用“请稍后核对”。

## 验收

- 渲染层用例先红后绿：生成报错 + 状态 `not_found` → 显示真实原因；状态 `unknown/preparing` 的既有文案不变。
- 桌面 `npm run typecheck` 与相关 `node --test` 通过。
- 界面与交互按桌面验收规则在 dev 应用核对（工具可用时）。

## 约束

- 真实库 `~/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite` 只读；演练用副本；动真实库前先备份。
- 在独立工作树改代码（dev 应用热更新会因主工作区源码变化重启）。不点任何“修复同步”。
- 报告和提交不含联系人姓名与聊天内容，联系人用编号或 `contact_id` 前 8 位。
- 本地提交（Conventional Commits，中文，无署名行），不 push。验证记录写入 `docs/verification/`，现行规格与 ADR 同步。

## Comments

## Answer

实现与验证已完成，等待主 Agent 独立双轴审查及协调本地提交。

- 生成失败 + 同一请求 `not_found` 保留安全错误，重复核对同样保留；已受理 `preparing` / `unknown` 保持既有文案与原请求核对，不自动重发。
- 来源待核验统一中文，提供“处理同步问题”按钮复用打开管理后台能力，文案引导联系人页既有处理入口；打开失败保留原因及按钮。来源失效仍撤下旧草稿、候选和依据。
- TDD：原错覆盖、缺失处理入口、IPC映射、已落库来源失败、草稿撤下与窗口打开失败均先 red 再 green。新增四项真实 React 行为测试。
- 命令：`cd desktop && npm run typecheck`；`node --test tests/sqlite-reply-candidates.test.mjs tests/sqlite-reply-candidate-bridge.test.mjs`（43/43）；最后两处小修复分别复跑 `node --test --test-name-pattern='来源待核验错误' tests/sqlite-reply-candidates.test.mjs` 及 typecheck，通过。
- 记录：`docs/verification/sync-simplification-07-reply-failure-20261107.md`；同步 `architecture/current/reply-generation.md`。
- 数据影响：无库迁移/写入、无模型调用/聊天发送；仅本次渲染范围内存保留脱敏错误和请求键，切换/失效/新生成清除。真实库与现场围栏未操作。
- 剩余风险：用户禁止切换/重启真实 App，因此未做运行中 dev 的 Computer Use 视觉验收；headless Chrome 验证真实 React 事件和合成窗口桥，不证明真实窗口导航。管理后台打开后仍需进入联系人页既有处理入口。

独立审查：Standards 0 项、Spec 0 项。提交由主 Agent 按本任务七个文件创建；真实应用验收因用户禁止重启或切换真实应用而留待后续。
