# 09 运行开始后才就绪的图片不会进入当前 run

- 现象：王威 14 张图片均已就绪（`media_file` 14 个 `current` 可显示文件，14 次获取 `completed/full`），但只有 1 张进了提取。
- 原因：`runs.ts` 创建 run 时一次性冻结 target（`currentMessageRows` 要求当时已有当前内容）。run `902ca95f` 于 11-07 22:01:55 启动，433 个 target；另 13 张图片在 22:05:55–59 才就绪，晚于冻结，不在 run 内。
- 后续补入只靠增量准入／新的 history run；`manual` 模式没有调度器，所以不会自动补。
- 待查：run 启动前是否应等待当前绑定下的图片获取完成，或在 run 汇总里提示「仍有 N 张图片未纳入」。
- 来源：只读查询 notalone.sqlite 与 `runs.ts` 阅读，无聊天内容。
