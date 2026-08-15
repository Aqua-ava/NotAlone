# Issue tracker：Local Markdown

本仓库的任务与规格以 Markdown 文件保存在 `.scratch/`。

## 约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- 功能规格：`.scratch/<feature-slug>/spec.md`
- 每张实现任务单独保存：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- 编号从 `01` 开始，不使用一个文件合并多张任务
- 每张任务顶部附近使用 `Status:` 记录 triage 状态
- 评论和讨论追加到文件底部的 `## Comments`

## 发布到 issue tracker

当 skill 要求“publish to the issue tracker”时，在 `.scratch/<feature-slug>/` 中创建对应文件。

## 获取任务

读取用户指定路径或编号对应的任务文件。

## Wayfinding 约定

- Map：`.scratch/<effort>/map.md`
- 子任务：`.scratch/<effort>/issues/NN-<slug>.md`
- `Type:` 可为 `research`、`prototype`、`grilling` 或 `task`
- `Status:` 可为 `claimed` 或 `resolved`
- `Blocked by: NN, NN` 记录依赖
- 开始处理前将状态改为 `claimed`
- 完成后写入 `## Answer`，将状态改为 `resolved`
