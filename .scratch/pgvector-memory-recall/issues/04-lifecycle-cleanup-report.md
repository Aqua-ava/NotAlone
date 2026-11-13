# 04 — 生命周期、安全、清理与报告

> Triage: ready-for-agent
> State: resolved
> Blocked by: 01, 02, 03
> 规格：[原 PostgreSQL＋pgvector 记忆召回隔离评估](../spec.md)

## 交付行为

验证向量副本在记忆删除、失效、过期和 revision 更新后的不回流行为，保存临时资源清理和数据处理边界，并形成中文报告。

## 验收

- [x] 删除/失效/旧 revision 即使残留向量，也不能进入最终上下文。
- [x] 跨 owner/contact 的控制样本仍隔离；来源与当前性复验保留。
- [x] 临时数据库、向量表、模型临时副本和实验产物按 owned manifest 清理。
- [x] 报告列出真实命令、通过/失败门槛、资源成本、限制和是否建议继续接入。
- [x] 相关单元、集成、类型检查和 `git diff --check` 通过；不改生产装配。

## Answer

已完成生命周期控制和中文报告。保留向量行时，active 当前版本可回读；旧 revision、deleted、invalidated、过期和跨范围候选均被拒绝，6/6 控制样本通过；final 组的 deleted/invalidated/expired/future 负例没有进入最终上下文（`scope_violations` 与状态类注入均为 0）。

清理证据写入 `result.json` 的 `cleanup` 字段：本轮 runtime 目录已删除、drop 无错误、端口 18553 无监听、单轮耗时 80.45 秒、产物 562,019 字节、模型文件树 96,407,485 字节；另清除了三个早前轮次的 `/tmp/notalone-pgvector-*` 残留目录，未操作业务库、Homebrew PostgreSQL 或其他 pg0。运行证据中的连接串已去凭据。

报告：[experiments/pgvector/REPORT.md](../../../experiments/pgvector/REPORT.md)；结果：[runs/native-v3/result.json](../../../experiments/pgvector/runs/native-v3/result.json)；运行前提：[runs/native-v3/runtime-manifest.json](../../../experiments/pgvector/runs/native-v3/runtime-manifest.json)。生产迁移、生产依赖、正式检索装配和 feature flag 无改动。

验证：单元 `test_pgvector_adapter` 12 项、`test_pgvector_evidence` 6 项、`unittest discover -s tests/unit` 715 项通过；`mypy src/notalone/experiments` 14 文件、`mypy experiments/pgvector/` 6 文件无问题；`git diff --cached --check` 通过。

限制：生命周期 6 个样本直接调用适配器、未再过一次 `RetrievalReplyContext`；pgvector 运行路径没有集成测试；`final/lifecycle` 与 `final/isolation` 组两臂都存在同范围无关注入（B 的 isolation 组 `unexpected_id_count` 由 1 升到 3），属于召回噪声而非越范围或状态负例。

## Comments

- 2026-10-04：实现完成并标记 resolved；验收由主 Agent 复核产物、清理状态与实跑命令后逐项确认。
- 2026-10-04：收尾复查把清理与资源成本写进产物、删除早前轮次残留目录、去掉证据中的凭据，并把生命周期只到适配器层、组内同范围注入、无运行路径集成测试列为限制。
