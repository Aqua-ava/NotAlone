# 10 集成并行任务

接手 DSH/TS 迁移票 10 的隔离集成，不要只做只读报告。所有路径均相对仓库根目录。

1. 先读 `docs/agents/workflow.md`、`engineering.md`、`domain.md`，再读 `.scratch/dsh-ts-migration/spec.md` 的 10、`planning.md`、`next-agent-handoff.md`、`task10-implementation/handoff.md` 和 `delivery-default-a-v2/default-a.patch`。
2. 冻结 target `6e3a864ca5653311957b106e16130084b5f5c12a`，base `b0a6817582d92b4142977c486fe7a9366496cb88`。
3. 在隔离临时 worktree 验证冻结补丁与当前主树冲突，完成可独立完成的唯一 Worker、队列、观察调度与 owner 进度整合，产出 root 可精确接收的 patch 或提交。
4. 不写主工作树 source/index；不修改 07 UI、21 Vision、root 正在改的 L3 回复文件；不打包、push、PR 或发送外部消息。
5. 测试仅用独立合成 PG/临时目录；禁止写 5432 的 `notalone_dev`。
6. 用户明确授权并行：需要 07/21 接口结论时，直接给 `/root/task07_ui_audit` 或 `/root/task21_vision_audit` 发消息，并同步 `/root`。

交付：精确冲突与整合顺序；补丁/隔离提交和哈希；最小→相关→类型检查证据；整票剩余项；数据处理和资源清理影响。审计写 `root-next-10/audit.md`，完成后向 root 发 `FINAL_ANSWER`。
