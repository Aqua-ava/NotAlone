# 两路性能优化集成结果
Triage: ready-for-agent
State: resolved

## Answer

2026-10-19 完成并合入本地 main。原始性能基线为 `746bb40b7a0a90105c39f76d2786c451a55c93f7`，两个独立工作树均从规划后的最新 main `92e2599b` 创建。导入实现/证据为 `20ed6feb`、`48733a78`，召回实现/证据为 `31022834`、`59de4943`；全部已合入 `7f1b6d8a`。没有 push、PR 或打包。

## 前后对照

导入相同合成输入，每版每档预热一次，再保留 7 个计时样本。以下为中位数；范围、输入摘要、SQL/协议和独立内存数据见 [导入记录](issues/01-import-batch.md)。`save` 包含新连接、范围锁、保存与提交；`import_file` 包含文件读取、解析、规范化、真实规则读取、完整仓储及提交，均排除夹具建立和事后查询。

| 指标 | 优化前 | 优化后 | 观测变化 |
| --- | ---: | ---: | ---: |
| 1000 条追踪业务 SQL | 2001 | 4 | 减少 99.80% |
| 1000 条追踪 save | 76.495 ms | 42.883 ms | 中位数减少 43.94% |
| 10000 条追踪 save | 839.721 ms | 491.415 ms | 中位数减少 41.48% |
| 1000 条完整文件导入 | 449.842 ms | 441.597 ms | 中位数减少 1.83% |
| 10000 条完整文件导入 | 4460.351 ms | 4283.280 ms | 中位数减少 3.97% |
| 100 条追踪 save | 11.054 ms | 12.626 ms | 中位数增加 14.23% |

小负载未显示稳定提速，完整导入区间重叠。1000 条完整导入全部显式 SQL 为 5016→3019，实际 libpq F.Sync 为 2017→18；Sync、驱动等待及网络往返含义不同。每轮仍为一次提交，原子性不变。追踪 save 的独立 Python 峰值约增至 2.5 MB；10000 条完整导入为 116.9→120.7 MB。2 MiB 参数预算不是 Python 峰值上限。

召回固定 20 条候选、1000 条记忆，基线和新实现使用相同文本、ID及向量。分词和 sqrt 均为 20020→1020，embedding 输入仍为 1020。公开 BM25 精确分数及有序候选 ID 相同。[召回记录](issues/02-recall-batch.md) 包含三档负载、原始摘要及复现命令。

| 召回指标 | 优化前 | 优化后 | 样本 |
| --- | ---: | ---: | ---: |
| 固定 16 维向量评分中位数 | 420.194 ms | 80.965 ms | 每版 21 轮 |
| 真实本地模型完整召回中位数 | 5379.210 ms | 4767.190 ms | 每版 21 轮 |
| 真实本地模型完整召回 P95 | 5771.971 ms | 5620.899 ms | nearest-rank |
| 单次 Python 峰值 | 1546096 bytes | 1729638 bytes | 独立单次测量 |

真实模型为预置的固定快照、512 维，仅编码合成文本，未下载或外发。完整召回观测中位数减少 11.38%，范围有重叠；编码量不变，不把编码时间波动归为优化收益。固定向量约 5 倍的评分收益不代表真实整体收益。每次调用多约 184 KB Python 临时统计，调用结束即释放；峰值不包含原生模型、预建输入或进程 RSS。

## 组合验证与审查

- 主会话在组合 main 先跑导入到提取追踪单例，再跑相关 105 项单元与 8 项集成；全部通过。最终追加的基准 CLI 单元也通过。
- 最终 main 的 112 项相关回归全部通过，包含导入、追踪、观察仓储、来源删除、规则摘要及基准 CLI；限时 600 秒，实际约 10 秒。主会话随机自有测试库均在清理后按精确名称查询确认不存在。
- 执行会话的召回 61 项相关单元、17 项 L1 HTTP 回归，以及导入 112 项相关回归、45 项单元均通过。测试集合有重叠，不合计为独立用例总数。
- 独立 Standards / Spec 对实现、脚本和原始样本增量审查，均无待修发现。基准工具的 hostaddr/service/环境覆盖和全序正文校验意见已修复关闭；全部样本摘要和计数已独立重算。
- 未宣称全量通过。扩大检查中的联系人删除测试 `_fixture` 加载错误已在原始基线复现；本轮未扩改旧测试。

主会话实际后端命令在 `backend/`，统一 `PYTHONPATH=src:. NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1`，使用工程规定的 NotAlone Python。单元模块与两路任务记录一致；集成临时运行器只装载现有公开测试、建立自有随机库并复核删除。

```sh
python /tmp/notalone-import-recall-isolated.py tests.integration.ingest.test_source_processing_trace.SourceProcessingTraceTest.test_imported_record_is_connected_to_actual_extraction_window
python -m unittest tests.unit.memory_extraction.test_recall tests.unit.memory_extraction.test_adoption tests.unit.memory_extraction.test_all_source_adoption tests.unit.memory_extraction.test_merge tests.unit.ingest.test_import_command tests.unit.ingest.test_jsonl_reader tests.unit.ingest.test_models tests.unit.ingest.test_normalizer tests.unit.ingest.test_preview tests.unit.ingest.test_rule_capture tests.unit.ingest.test_validator -v
python -m unittest tests.unit.ingest.test_source_processing_benchmark -v
perl -e 'alarm 600; exec @ARGV' -- python /tmp/notalone-import-recall-isolated.py tests.integration.ingest.test_source_processing_trace tests.integration.ingest.test_import_command tests.integration.persistence.test_postgres_repository tests.integration.persistence.test_observation_store tests.integration.persistence.test_source_deletion tests.unit.ingest.test_rule_capture tests.unit.ingest.test_source_processing_benchmark
```

组合日志：`/tmp/notalone-import-recall-combined-single.log`、`-combined-unit.log`、`-combined-integration.log`、`-benchmark-cli.log`、`-final-related.log`，共同前缀为 `/tmp/notalone-import-recall`。两路基准原始 JSON 的精确路径在各自任务记录。

## 实际开发版验收与资源清理

先检查开发实例为 stopped，随后仅以 `npm run dev -- --user-data-dir` 启动独立合成夹具；确认实际 development 宿主及监督器，没有打包实例。Computer Use 在真实 Electron 窗口中完成：明确选择合成联系人甲、文件与资料归属，预览 6 条记录、勾选确认并正式导入；刷新后任务全部步骤成功。来源过程显示 6 条记录，展开首末记录可见 position 0/5、locator 与 message/source_ref 收据。重新预览并确认同一文件，显示新增 0、已存在 6；联系人甲仍为 6 条消息/1 份来源，联系人乙为 0/0，且来源列表为空。

本验收没有操作微信或发送外部消息。隔离导入夹具没有向 create_app 注入 memory_service，记忆面板对应接口返回 503；确认属于夹具装配边界，本轮不认证该面板。记忆更新、合并和逐条采纳由 L1 HTTP 测试覆盖，不将其描述成实际 UI 通过。

正常退出开发 App 后，测试库已删除，但临时 wrapper 替换模型后仍沿用旧 gates 清理回调，导致 instance_ok=false。只修正仓库外临时 wrapper 的回调，重新运行独立夹具停止检查，确认 instance_ok=true、class_ok=true、database_remaining=false；原始异常证据保留端侧。另按原归属标记核验原数据库不存在、全部自有 PID 已退出，再删除本轮合成用户目录。开发缓存 app 875083 bytes、vite 2793241 bytes 均在核对未跟踪及无进程引用后清零，共 3668324 bytes。原项目入口此前未运行，结束后维持 stopped；原工作区改动未处理。

桌面与清理日志为 `/tmp/notalone-import-recall-native.log`、`/tmp/notalone-import-recall-cleanup-check.log`、`/tmp/notalone-import-recall-desktop-cleanup.json`。

## 数据影响与剩余边界

只处理合成资料。产品仍按 owner/contact 隔离；规则版本逐次读取、调用方事务、来源收据、撤销和删除路径保持，未增加长期正文或向量缓存。召回统计与批写编码仅在当前执行内存活，不新增迁移、外部模型调用或同步授权。性能改善集中在已测路径；内存增加及小负载波动已保留，不能据此宣称整个 App 提速同一倍数。完整公开历史仍须按工程工作流检查，既有 26 处历史命中不代表本轮新增。
