# 07 UI 并行任务

接手 DSH/TS 迁移票 07 的剩余实现与验收，不要只做只读报告。所有路径均相对仓库根目录。

1. 先读 `docs/agents/workflow.md`、`engineering.md`、`domain.md`，再读 `.scratch/dsh-ts-migration/spec.md` 的 07、`planning.md`、`next-agent-handoff.md` 和 07 证据。
2. 核对提交 `08e90b8f` 与当前主树，补齐 07 剩余 UI/测试缺口，按 RED→最小 GREEN→相关测试推进。
3. 独占 desktop 中 07 相关文件；不要修改 `backend/src/notalone/persistence/layered_memory.py`、主会话正在改的 L3 回复测试、task10 extraction 或 task21 foreground 文件。
4. 不打包、不 push、不 PR、不发送外部消息。测试资源使用独立临时目录和合成数据；不得写 5432 的 `notalone_dev`。
5. 真实 App 由 root 统一占用。把 ran 的精确 CUA 操作矩阵交给 root，不要自行操作当前开发 App。
6. 用户明确授权并行：需要 10/21 接口结论时，直接给 `/root/task10_integration_audit` 或 `/root/task21_vision_audit` 发消息，并同步 `/root`。

交付：状态与剩余验收清单；实际代码/测试提交；ran 操作矩阵；证据路径和风险。审计写 `root-next-07/ui-audit.md`，完成后向 root 发 `FINAL_ANSWER`。
