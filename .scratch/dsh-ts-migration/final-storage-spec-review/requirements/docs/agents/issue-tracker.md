# Issue tracker：Local Markdown

本仓库的任务与规格以 Markdown 文件保存在 `.scratch/`。

## 约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- 功能规格：`.scratch/<feature-slug>/spec.md`
- 每张实现任务单独保存：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- 编号从 `01` 开始，不使用一个文件合并多张任务
- 每张任务顶部附近使用 `Triage:` 记录下一步处理角色，取值遵循 [Triage 标签](triage-labels.md)
- 每张任务顶部附近使用 `State:` 记录执行进度，取值为 `open`、`claimed` 或 `resolved`
- 评论和讨论追加到文件底部的 `## Comments`

## 发布与获取

- **发布**：skill 要求“publish to the issue tracker”时，按上述路径创建文件。新任务的 `State:` 为 `open`；文件、`Triage:` 和 `State:` 均已写入且取值有效才算完成。
- **获取**：读取用户指定路径或编号对应的任务文件。

## Wayfinding 约定

- Map：`.scratch/<effort>/map.md`
- 子任务：`.scratch/<effort>/issues/NN-<slug>.md`
- `Type:` 可为 `research`、`prototype`、`grilling` 或 `task`
- `Blocked by: NN, NN` 记录依赖
- 开始处理前将 `State:` 从 `open` 改为 `claimed`
- 完成条件：`## Answer` 已写明结果及真实验证；满足后将 `State:` 改为 `resolved`
