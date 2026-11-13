# 02 桌面用户动作静默失败

Triage: ready-for-agent
State: resolved

## 目标

用户可感知的桌面操作失败不再静默：`SkillLearningPage.tsx:56,101-104` 4 处、`backend-status.tsx:48,50` 2 处、`RewritePanel.tsx:219` 1 处 `.catch(() => {})` 改为写可见错误/状态。

## 证据

`.scratch/code-audit-20261022/verify-structure-defense.md` 第三节 C1-C3；Lead 已抽查确认源码现状。

## 范围

- `desktop/src/renderer/SkillLearningPage.tsx`：复用同文件 `run()`（:60）统一 setError。
- `desktop/src/renderer/backend-status.tsx`：重试连接/重试停读按钮失败可见（错误文案或状态）。
- `desktop/src/renderer/RewritePanel.tsx:219`：候选修改来源/复制失败可见。
- 不改后端契约；不改其他 19 处已确认有意的清理路径 catch。

## 验收

- `cd desktop && npm run typecheck` 通过。
- 相关 node 测试：`node --test tests/**` 中覆盖这三个页面的用例（按实际存在文件）；必要时补最小渲染断言。
- 报告 UI 文案与错误状态落点；不启动第二个开发实例。

## Comments

- 2026-10-22 desktop-cleaner：已认领并实现（State: claimed → resolved）。
- 改动：`desktop/src/renderer/SkillLearningPage.tsx` 把 `run()` 前移为统一错误出口，覆盖历史自动读取与「开启/关闭整理、刷新待审核、继续整理」4 处；`backend-status.tsx` 为两个重试按钮增加 `actionError` 并在连接卡内 `role="alert"` 显示；`RewritePanel.tsx` 的复制来源记录失败改为可见提示，不再静默。
- 验证：`cd desktop && npm run typecheck` 通过；`node --test tests/failure-visibility.test.mjs tests/skill-learning/view.test.mjs tests/managed-shutdown.test.mjs tests/startup-continuity.test.mjs tests/reply-generation-guidance.test.mjs` → 24 通过 0 失败。
- 覆盖变化：新增 `tests/failure-visibility.test.mjs`（safe-node，3 个源码契约断言，防静默 catch 回流）；未新增 IPC。
- 风险：错误文案为固定中文提示，不向用户暴露底层异常文本；其余已确认有意的清理路径 catch 未动。
