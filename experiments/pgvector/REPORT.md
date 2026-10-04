# 原 PostgreSQL＋pgvector 隔离评估报告

日期：2026-10-04

本报告记录的是隔离实验，不是生产接入。实验只使用 `hindsight-synthetic-v2` 的合成已采纳联系人记忆；没有读取业务数据库、真实聊天或 `.env`，没有启动 Hindsight 服务，也没有修改正式检索装配。

## 运行边界

- A：现有确定性中文词法检索和 `RetrievalReplyContext`（合成夹具中的 `InMemoryRetrieval`，两臂共用同一份快照）。
- B：本地 `BAAI/bge-small-zh-v1.5`（512 维）生成 embedding，临时 pg0 中的 pgvector 只返回候选 `memory_id`，再由本地权威 `confirmed_memory` 路径复验联系人范围、active、有效期、来源和 revision，最后走同一个 `Context.build` 与 `validate_current`。
- 向量表不保存关系记忆正文，只保存 `memory_id`、`owner_id`、`contact_id`、revision、正文哈希、模型标识/版本、维度和 embedding。
- 阈值只在 dev 集校准：候选阈值网格取自 dev 的 30 条 query（601 个候选分值，dev 的算术上限为 30×20=600 加 1.0 边界），其中 28 个满足“dev 无关注入不高于词法基线”。冻结值 `tau=0.5767089472239593`；最终集没有回调阈值，逐阈值行全部保存在 `calibration.threshold_rows` 供复核。
- 本次写入 393 条联系人记忆向量，使用 pgvector 0.8.5 和 HNSW 索引；运行时使用独立 pg0、端口 18553，完成后已停止并删除临时目录。
- 隔离边界：实验进程只连固定的 loopback 临时库，显式拒绝读取 `DATABASE_URL` 等环境变量；不使用任何业务凭据。

## 最终结果

| 指标 | A 词法基线 | B pgvector 候选 | 结果 |
|---|---:|---:|---|
| 中文改写 Recall@5 | 1.67% | 26.39% | 提升 24.72 个百分点，通过 |
| 中文改写误注入 query | 3/60 | 19/60 | 增加 |
| 质量组误注入 query | 15/95 | 36/95 | 增加，未通过 |
| 直接 Recall@5 | 94.17% | 94.17% | 未下降，通过 |
| 完整检索 P50 | — | 16.61 ms | — |
| 完整检索 P95 | — | 24.16 ms | 通过 1 秒门槛 |
| 完整检索最大值 | — | 32.24 ms | — |
| 失败 / 越预算 / 重复 / 越范围 | — | 0 / 0 / 0 / 0 | 通过 |

计时的分母是 103 条 final query 全部包含失败与空结果的完整尝试；`quantile_rule` 为排序后第 `ceil(p*N)` 个值。耗时包含 embedding、pgvector SQL、候选映射、本地权威复验和现有关键路径上下文选取。

生命周期控制样本全部通过（6/6）：向量残留时，旧 revision、deleted、invalidated、过期和跨范围候选均未进入最终上下文；active 当前版本可以正常回读。

综合结论是 **未达到接入门槛**。向量候选确实提升了中文改写召回，且本机延迟很低，但它把无关注入从 15/95 提高到 36/95（直述组误注入也从 5 增到 13）；当前产品要求“覆盖提高且无关注入不增加”，所以不能据此接入生产。

## 校准与复跑

- dev 与 final 严格分离：候选阈值网格只由 dev 候选分值构成（`calibration.threshold_source`、`threshold_count`、`threshold_rows`），final 只用于冻结阈值后的对照与计时。收尾时修正了此前把 final 相似度也放进候选网格的做法，并重跑；冻结 `tau` 与全部指标不变，说明此前的选择没有落入 final-only 分值，但旧做法本身违反隔离要求，已不再保留。
- 同一命令、同一冻结模型与数据重复运行（旧 `native-v2`、本次 `native-v3` 修正设置后）：A/B 的选中记忆集合、`tau`、六项 gate 结果和生命周期 6 个样本完全一致，均为 `verdict=未达到门槛`；只有绝对延迟不同（旧运行 P95 16.31 ms，本次 24.16 ms），都远低于 1,000 ms 门槛。实验目录只保留本次运行的 [result.json](runs/native-v3/result.json)，运行前提证据在同目录 [runtime-manifest.json](runs/native-v3/runtime-manifest.json)。

```bash
PYTHONPATH=src:. /tmp/notalone-hindsight-runtime-f7dd3f4/venv/bin/python \
  -m experiments.pgvector.evaluate \
  --model-path /tmp/notalone-hindsight-runtime-f7dd3f4/models/hub/models--BAAI--bge-small-zh-v1.5/snapshots/7999e1d3359715c523056ef9478215996d62a620 \
  --output experiments/pgvector/runs/native-v3 \
  --runtime-dir /tmp/notalone-pgvector-memory-recall-run-20261004-v3
```

`result.json` 记录 `provenance.code_commit_at_run`（运行开始时采样）、9 个参与源码的 SHA-256 和相对该提交的 `participating_diff_sha256`；`environment` 记录 Python、平台、pg0、psycopg 和 `sentence-transformers` 版本；`embedding` 记录模型 ID、revision、维度、设备和模型文件树摘要；`runtime` 记录 vector 扩展版本和数据摘要；`candidate_limit=20` 与候选预算一起落盘。逐 query 结果、阈值、数据哈希、耗时分位数和生命周期证据都在同一文件中。

## 清理与数据处理边界

- 本轮临时 pg0 实例 `notalone-pgvector-memory-recall` 已停止并 drop，runtime 目录（含向量表、数据库目录和 manifest）已删除，端口 18553 无监听；`result.json` 的 `cleanup` 字段记录目录是否移除、drop 错误、运行耗时（73.94 秒）、产物大小和清理范围。
- 收尾时同时清除了早前轮次留下的 `/tmp/notalone-pgvector-memory-recall-run-20261004`（仅剩一个过期 manifest）、`…-run-20261004-v2`（空目录）和 `/tmp/notalone-pgvector-native`（空目录）；清理只针对 `notalone-pgvector-` 命名资源，未操作业务库、Homebrew PostgreSQL 或其他 pg0。
- 证据文件不包含数据库凭据：运行证据里的连接串统一去掉用户信息（`postgresql://127.0.0.1:18553/postgres`），正式装配和产品依赖未改。
- 资源成本：单轮完整运行 73.94 秒；写入 393 条 512 维向量；本地模型文件树 96,407,485 字节（约 92 MiB）；结果与 manifest 合计约 0.55 MB；CPU 运行，无 GPU。
- embedding 是从合成正文派生的数据，只存在于本次临时数据库和结果中的向量表元数据里；临时库删除后不再保留。模型缓存和独立 venv 沿用先前 Hindsight 实验保留的 `/tmp/notalone-hindsight-runtime-f7dd3f4`（公开模型与依赖，不含记忆正文）；复跑需要重新下载模型。
- 逻辑删除与目录移除不证明 WAL 历史、备份或介质物理擦除。

## 限制

- 两臂使用实验夹具中的内存基线，未直接连接正式 `PostgresRetrieval`；它共用同一词法排序与 `Context.build` 代码路径，但不证明正式 PostgreSQL 查询计划与事务行为下的同等表现。仓库内也没有针对 pgvector 实验运行路径的集成测试，`store.py` 的 `max_distance` 分支目前没有调用点。
- 校准集只有 30 条 query（15 条改写）；被选中的 dev 阈值在 dev 上无关注入为 0，但在 final 质量组上升到 36/95，说明这个小 dev 集上的“无关注入不增加”约束不能迁移到 final。实验据此保留 `tau` 不做最终集回调，并把“未达到门槛”作为结论，而不是重新调参。
- 阈值网格只含 dev 候选分值，因此选出的 `tau` 是“dev 可行集合内的最优”，不搜索 final 分值附近的其他阈值；这是隔离要求带来的覆盖损失。
- 本地 embedding 与 pgvector 候选只证明本机成本；未测并发、索引更新成本和长期运行表现。记忆检索端口没有超时参数，所以“超时不从分母移除”在当前实现中是空条件。
- 本报告不批准生产接入：接入需要新的用户决策、隐私评审和 ADR 复审。

## 验证记录

```bash
source /Users/local-user/miniconda3/etc/profile.d/conda.sh && conda activate NotAlone
PYTHONPATH=src python -m unittest tests.unit.experiments.test_pgvector_adapter -v   # 12 项通过
PYTHONPATH=src python -m unittest tests.unit.experiments.test_pgvector_evidence -v  # 6 项通过
NOTALONE_DISABLE_DOTENV=1 PYTHON_DOTENV_DISABLED=1 PYTHONPATH=src python -m unittest discover -s tests/unit -t .  # 715 项通过
PYTHONPATH=src python -m mypy src/notalone/experiments --follow-imports=silent       # 14 个源文件无问题
PYTHONPATH=src:. python -m mypy experiments/pgvector/ --ignore-missing-imports       # 6 个源文件无问题
git diff --cached --check                                                            # 通过
```

本实验代码只位于 `experiments/pgvector/`、实验适配器 `src/notalone/experiments/pgvector_adapter.py` 和对应测试文件中；正式 `PostgresRetrieval`、迁移、依赖和回复装配均未修改。
