# 01 — 临时 PostgreSQL＋pgvector 运行与实验向量表

> Triage: ready-for-agent
> State: resolved
> Blocked by: None
> 规格：[原 PostgreSQL＋pgvector 记忆召回隔离评估](../spec.md)

## 交付行为

提供只服务于本实验的临时 PostgreSQL＋pgvector 运行入口和向量表初始化。向量记录必须带本地记忆身份、范围、revision、内容哈希、模型标识和维度；实验只使用合成资料，不连接业务数据库。

## 验收

- [x] 能探测 `vector` 扩展，不可用时明确失败并保留前提缺失证据。
- [x] embedding 由固定本地中文模型生成；查询和资料使用同一模型与维度。
- [x] 向量表只保存候选导航所需字段，不成为事实来源。
- [x] 建立并验证精确或 HNSW 近邻查询；记录模型、扩展、运行时和数据哈希。
- [x] 启停和清理只触及本轮命名的临时实例、目录和产物。
- [x] 生产迁移、生产依赖、正式检索装配和 feature flag 无改动。

## Answer

已完成 `experiments/pgvector/` 临时 pg0＋pgvector 运行入口、BGE-small-zh-v1.5 512 维 embedding 边界和候选向量表。表只保存记忆身份、范围、revision、正文哈希、模型元数据和 embedding；未保存正文，也未连接业务库。已实测 psycopg2 UUID 写入、精确查询、HNSW 初始化和距离阈值查询，运行后删除了临时实例与目录。

验证：临时 pg0 使用 pgvector 0.8.5，HNSW 初始化成功；正式运行写入 393 条合成联系人记忆向量。产物中 `runtime`/`vector_table`/`environment` 字段记录 pg0 0.15.0、psycopg2 2.9.11、Python 3.11.15、扩展 0.8.5、`index_method=hnsw`、`hnsw_error=null` 和数据摘要；`result.json` 的 `cleanup` 记录本轮 runtime 目录已删除、drop 无错误、端口 18553 无监听；收尾时另外清除了三个早前轮次的 `/tmp/notalone-pgvector-*` 残留目录。

限制：实例名与端口是实验级常量而非轮次级命名，同一时间只能有一轮实验使用该实例；`vector` 扩展不可用时会写进 `precondition_error` 与 `runtime-manifest.json`，但 `CREATE EXTENSION` 失败仍让本轮中止且不产生 `result.json`。仓库内没有覆盖 `store.py`/`runtime.py` 运行路径的集成测试，`nearest` 的 `max_distance` 分支目前没有调用点。

## Comments

- 2026-10-04：实现完成并标记 resolved；验收由主 Agent 复核产物与实跑证据后逐项确认。
- 2026-10-04：收尾复查补齐证据链——运行证据已去凭据、manifest 复制到产物目录、清理结果写入 `result.json`；残留临时目录已清除。前提缺失落盘与运行路径集成测试仍列为限制，不影响本任务的隔离实验结论。
