# 最小命令与证据

从 `$REPO_ROOT` 执行，不activate、不启动App、不创建真实账本。以下命令没有真实供应商传输入口。

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/miniconda3/envs/NotAlone/bin:$PATH"
node .scratch/dsh-ts-migration/nonreply-formal-model-seam/cli.mjs plan --candidate-commit 4f89bb976dd4086a02b7ae983fee2760d6e4ff64
node .scratch/dsh-ts-migration/nonreply-formal-model-seam/cli.mjs preflight --candidate-commit 4f89bb976dd4086a02b7ae983fee2760d6e4ff64
node --test .scratch/dsh-ts-migration/nonreply-formal-model-seam/{executor,plan}.test.mjs
cd backend-ts
node --test test/extraction-flow.test.mjs test/extraction-batch-service.test.mjs test/nonreply-formal-model-seam-retry.test.mjs
npm run typecheck
node --test ../.scratch/dsh-ts-migration/nonreply-formal-model-seam/nonreply-formal-model-seam-retry.test.mjs
```

`preflight` 预期退出2并报告 `root_permission_required`，业务/供应商调用0。最小合同21/21、相关模块8/8与typecheck已实际运行；最后一条官方profile/PG/ModelHost故障测试对应实际红→绿记录，不属于正式质量。固定4f89成功非空E/V的命令为 `node .scratch/dsh-ts-migration/nonreply-formal-model-seam/synthetic-probe.mjs --synthetic-only`，本轮已有4次loopback HTTP证据，不为数量重跑。

根API先 `prepareFormalPlan({candidateCommit:完整新commit})`，再注入 `source`、`permission`、既有有限持久 `budget`、受控 `supplier.validate/send` 和 `business.open` 构造 `FormalExecutor`。先 `preflight()`；发送只通过 `executePair([冻结runId1,冻结runId2])`。默认 `engineering` 不认证正式质量，`formal` 需要独立根资格端口；没有文件/环境flag可解锁real。当前真实transport、其余三域业务适配及正式时间/语义/五阶段资格仍未完成。
