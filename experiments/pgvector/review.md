# pgvector 实验两轴审查与根收尾

固定点为任务发布提交 `3712347`（规格发布）/ `e015b96`（收尾前 HEAD），审查对象是本实验的全部工作树改动（14 个新增文件，后扩展为 17 个）。两个独立只读 Agent 并行审查，范围为：

```sh
git diff e015b96 -- .scratch/pgvector-memory-recall experiments/pgvector src/notalone/experiments tests/unit/experiments
```

## Standards

书面标准：已核对 `AGENTS.md` 产品边界、`docs/agents/engineering.md` 的适配层/环境/合成测试/Git 规则、`docs/agents/issue-tracker.md` 的状态与 Answer 规则、ADR-005 与 ADR-028 的向量补充边界。审查在收尾改动之前执行，发现 2 条硬性违规；两条都已按最小修法修复，但**没有再做第二轮独立复审**，修复后的代码只经过主 Agent 的测试、mypy 与实跑验证。

收尾前审查发现 2 条，均已修复：

- 4 张任务 `State: resolved` 但 22 个验收复选框全未勾选，违反 `docs/agents/issue-tracker.md` 的完成条件。已按证据逐项勾选，并把无法证明的边界（无运行路径集成测试、前提失败不落盘）写进 Answer 与限制，而不是直接标成通过。
- 暂存产物 `runs/native-v2/result.json` 落入含口令的连接串，违反 `docs/agents/engineering.md` 的“仓库中不得保存数据库凭据”。已新增 `redacted_db_url()` 并重跑，证据中的连接串统一为 `postgresql://127.0.0.1:18553/postgres`；旧产物已删除。

可选 Fowler 判断 3 条，已处理 2 条：`embedding.py` 的同值双分支已合并；`evaluate.py` 两处按位置参数重建数据集改为 `replace()`。`pgvector_adapter.py` 的 `search_confirmed_memories` 仍是较长函数（校验/复验/排序三段），保持现状以便诊断字段与拒绝原因集中可见。

边界核对全部通过：无生产装配、迁移、依赖或 feature flag 改动；只连固定 loopback 临时库并显式拒绝读取 `DATABASE_URL`；测试夹具全部为合成数据；报告结论为“未达到门槛”，没有把失败实验说成可用。

## Spec

**收尾前 1 项 P0 违规、4 项 P1 证据缺口，均已在收尾中修复；剩余能力缺口已如实降级为限制。** 修复后的实现由主 Agent 实跑验证，未再单独安排第二轮 Spec 复审。

- **P0 阈值候选网格含 final 相似度**：`_capture_hits` 遍历全部 133 条 query，`threshold_count=2637` 远超 dev 的算术上限 600（30×20），违反规格决定 6“只在独立 dev 集校准阈值”，且产物没有 `threshold_rows`，无法复核 argmax。已改为只捕获 dev 候选、只由 dev 分值建网格，并把全部 601 行（601 = dev 上限 600 + 1.0 边界）写入 `calibration.threshold_rows`；重跑后冻结 `tau` 与全部指标不变，说明原选择没有落入 final-only 分值，但旧做法不再保留。
- **P1 旧产物不可复核**：`native-v2` 无 `provenance`、无 `runtime-manifest.json`、连接串含凭据。已删除旧产物，改由 `native-v3` 作为唯一结果，manifest 复制到产物目录。
- **P1 provenance 采样时机**：原实现 `_provenance()` 在 `run()` 末尾读盘，记录的是结束时的文件而不是实际执行的代码。已改为运行开始时采样。
- **P1 清理证据缺失**：`result.json` 原本没有任何清理字段。已新增 `cleanup`（目录是否移除、drop 错误、端口、耗时、产物与模型占用）与 `environment`（Python、平台、pg0、psycopg、sentence-transformers）。
- **P1 单测覆盖缺口**：补齐 future `valid_at` 拒绝、显式 `memory_ids`/本人记忆/消息/上下文消息委托、以及证据去凭据与 provenance 字段，共 6 项新测试。

独立重算：审查 Agent 从 `vector_results`/`baseline_results` 按冻结 identity 重算宏 Recall、注入计数与 nearest-rank 分位数，与报告表格逐格一致；本次修正后的产物再次由主 Agent 复算，A 1.67%/B 26.39%、改写误注入 3/60→19/60、质量组 15/95→36/95、直述 94.17% 两臂相同、P50/P95/最大 16.62/28.22/54.06 ms、失败与越界计数全 0。

仍未修复、已作为限制记录：pgvector 运行路径无集成测试；`CREATE EXTENSION` 失败不落盘前提产物；实例名/端口是实验级常量而非轮次级；生命周期 6 例只到适配器层；`final/lifecycle` 与 `final/isolation` 组存在同范围无关注入；记忆检索端口没有超时参数，因此“超时不从分母移除”当前是空条件。

## 根收尾

主 Agent 完成最终验证：`test_pgvector_adapter` 12 项、`test_pgvector_evidence` 6 项、`unittest discover -s tests/unit` 715 项通过；`mypy src/notalone/experiments` 14 文件与 `mypy experiments/pgvector/` 6 文件无问题；`git diff --cached --check` 通过。

产物溯源已闭环：提交后核对发现产物的 `provenance` 对应的是提交前的工作树，随即用提交后的同一份源码重跑。最终 `runs/native-v3` 记录 `code_commit_at_run=e015b96`（实验代码合并前的提交）与 9 个参与源码的 SHA-256，后者与提交内容逐一相符；`participating_diff_sha256` 是按 `git diff e015b96 HEAD -- <9 个参与文件>` 计算、可重算的哈希（`adfbd786…`），因为实验代码本身随本提交加入，不能写成“与自身空 diff 相符”。指标与 `tau` 不变（P95 24.16 ms，运行 73.94 秒）。

清理与数据处理：本轮 pg0 已 drop、runtime 目录删除、端口 18553 无监听，`cleanup` 字段留证；早前轮次的三个 `/tmp/notalone-pgvector-*` 残留目录已清除；证据文件不含凭据。模型缓存与独立 venv 保留在 `/tmp/notalone-hindsight-runtime-f7dd3f4` 供复跑，复跑需重新下载模型。

结论保持 **未达到接入门槛**：改写召回提升 24.72 个百分点且 P95 远低于 1 秒，但质量组无关注入由 15/95 升到 36/95。未修改迁移、依赖、`PostgresRetrieval`、`reply_wiring` 或 feature flag，生产接入需要新的用户决策与隐私评审。
