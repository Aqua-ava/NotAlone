# Issue tracker：Local Markdown

本仓库的任务与规格以 Markdown 文件保存在 `.scratch/`。

## 约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- 功能规格：`.scratch/<feature-slug>/spec.md`
- 每张实现任务单独保存：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- 编号从 `01` 开始，不使用一个文件合并多张任务
- 每张任务顶部附近使用 `Triage:` 记录下一步处理角色，取值遵循 `docs/agents/triage-labels.md`
- 每张任务顶部附近使用 `State:` 记录执行进度，取值为 `open`、`claimed` 或 `resolved`
- 评论和讨论追加到文件底部的 `## Comments`

## 发布到 issue tracker

当 skill 要求“publish to the issue tracker”时，在 `.scratch/<feature-slug>/` 中创建对应文件。
新任务的 `State:` 必须为 `open`；完成条件是任务文件、`Triage:` 和 `State:` 均已写入且字段取值有效。

## 获取任务

读取用户指定路径或编号对应的任务文件。

## Wayfinding 约定

- Map：`.scratch/<effort>/map.md`
- 子任务：`.scratch/<effort>/issues/NN-<slug>.md`
- `Type:` 可为 `research`、`prototype`、`grilling` 或 `task`
- `Blocked by: NN, NN` 记录依赖
- 开始处理前将 `State:` 从 `open` 改为 `claimed`
- 完成后在 `## Answer` 中记录结果和验证，将 `State:` 改为 `resolved`
- 只有 `## Answer` 已写明结果且相关验证已经如实记录时，任务才算完成
