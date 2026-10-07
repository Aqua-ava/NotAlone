# 01：从提取窗口到最终保存结果的可查询追踪

Triage: ready-for-agent
State: resolved
Blocked by: None

## What to build

用户能从一个实际提取批次或最终候选/记忆，查到当时窗口、每次模型请求与原始响应、逐候选解析/核验/采纳/裁决及真实保存结果。拒绝、跳过、零候选和失败同样记录，已用来源删除可清除相关正文。来源的旧处理记录缺失如实显示，任务 02 再补齐新输入的最前段。

## Acceptance criteria

- [x] PostgreSQL 独立追踪保存并按联系人范围查询，无正文资料不挤入最小台账。
- [x] 实际窗口、完整请求/原始响应、来源校验、时间处理、语用/核验、门槛、重复、相似和裁决逐步可查。
- [x] 每个原始候选有稳定关联并连接真实候选/本人或联系人记忆/旧版本，无业务行的去向仍可查。
- [x] SDK 实际供应商请求及可见响应在既有模型调用内捕获，无额外语义调用或真实联网测试。
- [x] 追踪故障停止本批，不推进水位，不触发非法输出跳过；部分提交和未知结果如实保留，完成记录与水位可靠提交。
- [x] 全部窗口来源及参与判断的旧记忆来源进入删除依赖；上下文来源删除同样清除正文。
- [x] 在已确认提取/查询/删除接缝完成 red → green、相关类型与集成验证。

## Comments

2026-10-07：用户确认使用 PostgreSQL、三张任务拆分与公开测试接缝，允许连续实现。只处理合成资料与本任务隔离测试库，不迁移现有私人库。

## Answer

2026-10-07：实现 `memory_trace` 记录与查询 Interface、独立 PostgreSQL Adapter 和迁移 039。CLI 与 PG Runner 默认持久化；未知生产 port 漏传追踪会独立失败，只有显式合成内存存储使用内存 Adapter。追踪不依附 `background_task`，没有自动过期；未增加后台提取调度。已 fast-forward 合入集成 tip `0c77db6`。

每次执行保存真实消息读取筛选收据、精确窗口及来源缺口、原始候选稳定标识、解析前后、来源与片段规则、时间与语用字段、采纳门槛、重复/删除指纹、相似旧版本、裁决、计划/真实写入和水位。阶段载荷的 `_execution` 保存实际起止、状态、规则源码 SHA 和内容 SHA；仅捕获快照的节点明确标为 `snapshot_capture`，不把入库时间冒充执行时间。E/V/A 使用原提示词/schema/绑定语义，HTTPX hooks 捕获 SDK 最终正文原字符串、base64 和解析值、可见重试与返回；实际调用及最小台账 ID 可关联。与 `0fb5e00` 的三组提示词/schema 值比较均相等。

`TraceWriteError` 独立于模型错误。HTTP hook 内部中断越过 SDK 的 Exception 重试，回到模型边界转为公开错误。追踪结束与水位/非法输出失败计数在同一 PG 事务提交；提交回执丢失不会伪称回滚或覆盖已成功状态。部分业务提交保留计划 ID，由查询/重试的权威记录回执确认实际候选/记忆，不补造未捕获历史返回。来源/记忆/候选丢弃在原事务清除相关整批正文，保留非正文缺失标识；owner/contact 锁、运行状态和活跃依赖校验阻止删除后重新写回正文。

真实 red → green 记录（只使用合成资料）：

- 最初公开查询测试因 `memory_trace` 模块缺失失败，完整提取/PG 查询后通过。
- 上下文来源删除、单记忆删除和候选丢弃最初仍显示 `succeeded`/`recorded`，接入原删除事务后显示 `deleted` 且无事件正文。
- 人工确认提取候选最初反查 `not_recorded`，通过真实 `source_candidate_id` 后保留原提取追踪；纯手动来源最初误显示 `not_recorded`，按实际 manual 来源识别为 `not_applicable`，历史提取后人工确认仍不误归类。
- 写入后追踪故障最初只显示 `planned`，公开查询增加权威提交回执后确认已存在业务行；重试不创建重复候选。
- 混合结构拒绝、来源拒绝、非记忆、待确认最初缺少可查去向，保存全部原始候选关联后通过。
- 非原文核验片段最初缺少具体失败规则，保存 `quote_in_message` 等真实规则结果后通过。
- 提交确认丢失最初把真实成功批次覆盖成 `trace_failed`，限制失败标记仅作用于运行中批次后保持真实 `succeeded` 和水位。
- 筛选后无可提取消息最初没有批次，默认生产 Runner 现在保存 `skipped/no_eligible_messages`，不调用模型、不推进水位。
- 最初 SDK 实际请求测试缺少捕获模块；真实 SDK + 本地 HTTP transport 最终通过请求/返回原字符串、工具包装、thinking、重试和 E/V/A 三次调用验证。三类台账关联最初无事件，通过关联真实 ID 后与既有台账一致。

验证全部先激活 Conda `NotAlone`，设置 `PYTHONPATH=src`、`NOTALONE_DISABLE_DOTENV=1`，删除模型 key 环境变量。PG 仅使用 `postgresql:///notalone_memory_trace_be5912528896_test`：

- `python -m unittest discover -s tests/unit -t . -q`：948 项通过（基线 944 + 新 SDK 4 项）。旧合成 Runner 显式注入测试 Adapter；冻结实验测试在临时目录使用冻结提交的 Adapter，冻结 plan/runner/SHA 未改。
- 相关 PG 集成 153 项通过：新追踪 15 项，以及 memory/owner/pending/ledger/watermark/adoption/adjudication/source/observation/worker/retention 接缝。
- 最终候选与调用标识接线后，追踪 PG + SDK + Flow 单文件组合 31 项通过。未提供测试库时，新 PG 测试安全 skip（1 个类），不自动访问其他库。
- `python -m mypy --no-incremental --cache-dir /dev/null --follow-imports=silent --ignore-missing-imports <本次21个生产文件>` 通过。`worker.py` 9 项、`observation_store.py` 16 项既有错误保留；用 `MYPYPATH=src` 统一导入路径比较 `0fb5e00` 临时基线与当前文件，两侧同为 25 项且错误信息逐项相同。没有新增类型错误，不声称全仓类型通过。
- 本次 Python 变更用临时 formatter 作 isort/Black（79 列）整理；`git diff --check` 通过。新存储 SQL 换行前后 AST 相等。迁移 039 仅应用于隔离测试库；没有访问 `.env`、真实供应商、真实微信或私人 DB。

任务 02 交接：`load_contact_messages(scope, database_url, *, selection_receipts: list[dict[str, Any]] | None=None)` 保持返回 `tuple[MessageRef,...]`。`MessageRef.source_snapshots` 为 tuple，单项包含 `source_ref_id/source_id/source_kind/locator/capture_layer/raw_payload/processing_status/source_recorded_at`；当前已有 DB 投影使用 `capture_layer=legacy_projection`、`processing_status=missing`，不能冒充原始字节。02 可扩展 `processing_record` 等字段接入新来源处理记录。`message_snapshot` 保存 canonical DB 字段，标记 `normalized_message_row`；生产 CLI/Runner 把读取收据传 `run_extraction(selection_receipts=tuple(...))`。早于提取的来源处理/原始字节由 02 完成，01 不回填历史。

任务 03 交接：`PostgresExtractionTraceStore(database_url)` 的公开方法为 `list_batches(scope, limit=100)`、`get_batch(scope, trace_id)`、`find_record(scope, record_kind, record_id)`、`delete_batch(scope, trace_id)`。`record_kind` 为 `candidate/contact_memory/owner_memory`；反查状态为 `recorded/deleted/not_recorded/not_applicable`。详情含有序 `events`、非正文 `links`、`write_receipts` 与全部 `candidates` 去向。手动删除只清除追踪正文，保留权威记忆与缺失标记。Worker 已把公开 `TraceWriteError(stage, trace_id)` 分类为可重试 `trace_write_failed`；`commit_outcome=unknown` 提醒调用方查询真实提交结果。HTTP 授权、`Cache-Control: no-store`、App 展示和新 main 优先级模型装配集成由 03 继续验证；两轴 review 由 root 在三任务集成后执行。尚未做这些后续任务或 Swift 验证，不声称整个规格已完成。
