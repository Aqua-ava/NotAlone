# 02：从新原始聊天到规范消息的完整来源处理链

Triage: ready-for-agent
State: resolved
Blocked by: 01

## What to build

用户导入历史或同步已确认会话后，可以从提取结果一路回查到当时原始文字记录、解析、说话人和时间转换、规范化、过滤与去重，知道哪些数据在进入模型前已经改变。处理时间以实际发生为准，旧来源不伪造回填。

## Acceptance criteria

- [x] 历史导入保留所用原始 JSONL 记录原文与解析结果、定位、实际时间及规范化版本/转换结果。
- [x] CLI 只在已确认文字会话范围捕获投影前文字事件，保存说话人、时间、正文及去重/过滤定位，不保存整段输出或视觉帧。
- [x] 新输入的处理记录连接来源引用和规范消息，再连接提取追踪；消息已保存与模型曾读到明确区分。
- [x] 解析失败、筛选、重复、来源引用增补和历史缺失有真实结果，不把后台记账时间当作原始解析时间。
- [x] 来源删除、跨范围拒绝和处理记录写入故障通过公开入口验证，受影响快照不可恢复。
- [x] 在已确认导入/同步及查询/删除接缝完成 red → green 和相关验证。

## Comments

2026-10-07：依赖 01 的持久化与查询关联；不调用真实微信 CLI，不处理私人文件。

## Answer

2026-10-08：实现独立 `source_processing` 捕获模型、PostgreSQL 保存／查询边界与迁移 040、041，接入正式 JSONL 导入、已确认 CLI 后台增量和既有前台文字观察路径。已合入集成提交 `c728de0`；Swift 退役只来自该主线合并，本任务没有实现或修改展示层。没有改模型提示词、schema、分类、放行门槛或自动提取调度。

JSONL 仍由有界 UTF-8 bytes 经 `io.StringIO` 逐行解析，文件 SHA 保持按原 bytes 计算。只保存所用单条记录的准确原行、空白、换行、解析值和实际转换，不另存整文件。`parse/validation/normalize` 各自记录实际起止与执行规则文件 SHA；成功导入和 active 文件重复导入都在原业务事务内关联真实 `message_id/source_ref_id`。规范化输出 `converted` 与 canonical DB `message_snapshot` 分开，去重复用时不把传入投影视为已存在规范消息的新权威正文。

CLI 在核对预期 talker、已确认绑定后捕获文字事件的投影前原行与解析值。说话人、epoch／ISO 时间转换、缺失时间保留、空白过滤、稳定消息身份去重、真实来源引用增补均有收据。重复相同 locator 的事件按捕获 UUID 分别关联第一次创建和第二次复用，保留不同的 `source_ref_added`。非文字只保存判断所需的定位、种类、cursor 与过滤收据，不保存媒体原行、路径或正文。旧前台关闭窗口仅留定位与时间判断；过滤时间在实际筛选时记录，早于后续规范化。

损坏 JSON、编码、混联系人、无效时间和已确认范围内的导入拒绝只保存实际错误位置／阶段、代码和规则执行信息，不保存未校验原文或解析值。不可验证的 owner/contact 不创建伪范围记录。异常 cause 不带 JSON、原始 bytes 或无效时间输入，敏感记录的 repr 不含正文。通用导入回执故障标为 `import_outcome_unknown/business_commit_status=unknown`，不因返回丢失而宣称已提交资料回滚；确定的身份／重叠拒绝标为 `input_rejected`。

`SourceProcessingWriteError` 是独立安全错误，处理记录 API 故障会使导入、消息／引用与 cursor 的原事务回滚；前台／后台运行状态暴露 `source_processing_write_failed`。原来源删除事务同时清除新处理正文。手动删处理批次清除其原行，并保守清除相关整份提取追踪副本，理由为 `source_processing_deleted`；权威消息和记忆保留。提取开始校验复制的处理记录仍有效，阻止缓存来源快照进入模型；迁移 041 仅保存删除捕获 UUID 墓碑，阻止缓存规范消息另建批次重存旧原行。真实重新读取取得新捕获 UUID 可以继续处理，旧批次不恢复。重导入回归夹具相应改为重新读取合成文件，原有新来源、消息数量和引用断言不变。

真实 red → green（`tests/integration/ingest/test_source_processing_trace.py`，全部合成）：

- 最初查询因新 Module 缺失失败；正式导入后能回查准确 CRLF／空白原行、解析、说话人与时间转换，且实际窗口有相同来源记录。
- 重复导入最初只有一批记录，后来保留真实读取与来源／消息复用；同批相同 CLI locator 最初被最后一条收据覆盖，后来分别展示创建／复用。
- CLI 非文字最初在后台／前台入口丢失过滤定位，后来与文字处理并列；跨 talker 最初可附着正文，后来拒绝且不保存记录。
- 损坏 JSONL／CLI 最初没有失败批次，后来只留安全定位；CLI 前置空行最初误报第 1 行，后来标实际第 3 行；UTF-8 与时间异常最初通过 cause 暴露输入，后来仅留错误类别／真实位置。
- CLI 时间规范化失败最初无阶段收据，后来标实际 `normalize/failed`；关闭窗口最初把记账时间写成筛选时间，后来筛选结束早于选中消息的规范化开始。
- 分步 `record_cli_messages` 最初遗漏处理记录，后来在消息事务内关联；来源删除、手删处理批次最初留下正文／追踪副本，后来为 `deleted` 且清空正文。
- 缓存提取快照最初可进入模型，后来开始即失败；缓存规范消息最初能重存已删原行，后来墓碑拒绝并回滚，新实际捕获仍可处理。
- parsed-only 最初误称完整 `recorded`，后来 `partial` 且无原行／原解析时间；重叠导入最初无拒绝收据，后来只有无正文失败；导入回执丢失最初误称拒绝，后来标提交未知且查询仍看见真实已提交消息。

最终验证均激活 Conda `NotAlone`，设置 `PYTHONPATH=src`、`NOTALONE_DISABLE_DOTENV=1`，移除所有 API_KEY、LANGSMITH、LANGCHAIN 环境变量。固定 PG 只用 `postgresql:///notalone_memory_trace_be5912528896_test`；HTTP 原夹具另建随机 `_test` 库并清理，没有改其数据库选择：

- 来源链新增 29 项。记录故障通过仅对本测试 owner 生效的数据库触发器注入；导入、后台与前台入口均验证无业务正文保存／无 cursor 推进。跨 owner/contact 的列表、反查、详情和删除拒绝也通过。
- `python -m unittest discover -s tests/unit -t . -q`：948 项通过。
- `python -m unittest tests.integration.ingest.test_source_processing_trace tests.integration.ingest.test_import_command tests.integration.persistence.test_postgres_repository tests.integration.persistence.test_observation_store tests.integration.persistence.test_source_deletion tests.integration.persistence.test_source_reply_deletion tests.integration.persistence.test_observation_reply_deletion tests.integration.front_sync.test_front_sync_end_to_end tests.integration.front_sync.test_tail_lifecycle tests.integration.memory_extraction.test_extraction_trace -q`：166 项通过。
- `python -m unittest tests.integration.server.test_import_auto_flow tests.integration.server.test_model_priority_lifecycle tests.integration.server.test_core_business_flow tests.integration.server.test_first_import_api tests.integration.server.test_import_task_api -q`：51 项通过，包含自动历史导入与已集成 priority 行为；回环连接关闭出现原有 `ConnectionResetError` 诊断，测试全部成功。追加提交未知字段后另跑公开回执故障测试与完整 PG／unit 验证。
- `python -m mypy --no-incremental --cache-dir /dev/null --follow-imports=silent --ignore-missing-imports <本任务15个无既有诊断的生产文件>` 通过。以 `MYPYPATH=src` 在临时归档基线 `c728de0` 与当前 20 个生产文件比较，五个既有诊断文件两侧均为 123 项、错误信息逐项相同，0 新增：adapter 3、postgres_repository 11、observation_store 16、tail_lifecycle 2、cli_sync 91。没有解决或扩大既有类型诊断，不声称全仓 mypy 通过。
- `python -m notalone.database_migrations --migrations database/migrations` 仅在固定隔离库分别应用 040、041；保持已应用 040 的校验值。Python 文件用 isort／Black 79 列整理，`git diff --check` 通过。

03 稳定接缝：`PostgresSourceProcessingStore(database_url)` 提供 `list_batches(scope, limit=100)`、`get_batch(scope, batch_id)`、`find_record(scope, record_kind, record_id)`、`delete_batch(scope, batch_id)`；`record_kind` 为 `message/source_ref/source_document/local_wechat_observation`，反查状态 `recorded/deleted/not_recorded`。详情为 batch 元数据和有序 `records`，单条有 `record_id/batch_id/owner_id/contact_id/position/locator/message_id/source_ref_id/outcome/payload`，删除后正文与 locator 为空。

01 的 `load_contact_messages` 和读取收据签名保持；`MessageRef.source_snapshots` 新增 `processing_record`，包含持久化单条字段与 batch `status`。原输入层 `jsonl_record_text/cli_event_text` 为 `processing_status=recorded`；缺原行的 synthetic 数据为 `parsed_only/partial`、`parse.status=not_observed`，不伪造原解析版本或时间；无历史处理记录为 `legacy_projection/missing`。处理记录 `model_read_status=not_claimed` 表示此层不声明模型读取，实际曾读范围要通过提取窗口和调用事件判断。`message_snapshot` 仍为 canonical 规范消息字段。

本任务没有访问私人 DB、`.env`、真实 CLI 或模型；没有新增视觉帧保存或外部发送能力。040／041 含敏感正文结构与无正文墓碑，正式库迁移仍未执行，固定测试库由 root 最终清理。03 从迁移 042 起接 HTTP／CLI 查询、鉴权、no-store 和各入口故障／晚响应验收；展示层范围、全规格两轴 review 与最终集成由 root 后续完成，本任务不宣称整个规格完成。
