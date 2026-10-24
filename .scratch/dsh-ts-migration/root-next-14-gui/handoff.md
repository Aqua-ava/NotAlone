# Ticket 14 隔离 GUI 动作验收

## 目的

在开发 App 中补足“实际提交修正”和“删除单条背景”都能落到持久状态的证据。全部资料、owner、contact、消息和画像均为合成内容；不复用或修改正式库中的 `ran` 数据。

## 已准备

- `fixture.mjs setup` 创建随机 `_test` PostgreSQL、独立 userData、合成 owner/contact、两条本人记忆、一个 L2 场景和一个 2 条条目的 L3 画像。
- 开发 App 使用现有 `npm run dev -- --user-data-dir <独立目录>`，仍为源码热更新实例。
- 隔离 App 已显示“系统整理画像”、两条长期背景、引用、修正、删除和整份撤回入口。
- 修正表单在说明为空时禁用；取消路径已由正式 `ran` App 验证且无副作用。

## 待执行

1. 在第一个合成画像输入修正说明并提交。验证画像与批次 withdrawn、generation 前进、active feedback 存在、两条底层本人记忆仍 active。
2. 运行 `fixture.mjs rearm` 生成第二个合成画像，在开发 App 中执行“删除这条背景”。验证第二个画像与批次 withdrawn、generation 再次前进、active feedback 存在、底层记忆仍 active。
3. 操作前后均用无正文 SQL 元数据记录 profile/batch/withdrawal/feedback/generation/底层记忆状态。
4. 正常退出隔离开发 App，运行 `fixture.mjs cleanup` 删除随机测试库和临时目录，再重新启动默认 `npm run dev`。

## 安全边界

- 每次 GUI 修正或删除提交前单独取得用户动作时确认。
- 不修改正式 `notalone_dev`，不操作微信，不调用真实模型，不发送外部消息，不打包或 push。
- `/tmp/notalone-l3-gui-state.json` 仅保存临时路径和无敏感合成 UUID，执行 cleanup 后删除。
