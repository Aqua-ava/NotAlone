# 单绑定会话历史同步引擎与消息覆盖状态

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 02

按 [spec](../spec.md) 与 [ADR-100](../../../architecture/adr/100-authorized-private-history-sync.md)，为一个已授权绑定建立首次完整历史同步：从本机可读最早点分页读到启动时固定的水位线，再无缝转入增量。覆盖状态按 `owner_id + contact_id + binding_id` 独立持久化，至少区分尚未开始、同步中、完整、不完整（含原因）。历史正文只进现有消息与来源链路，状态输出只含元数据。

## 验收

- [x] 首次同步后该绑定本机可读历史全部可检索；重复运行不重复写入，已有 cursor、文件导入来源和重叠历史不阻断读取。
- [x] 历史读取期间插入的新消息进入同一去重与来源链；历史追平水位且无更早页面后无缝转增量，无断档、无重复推进。
- [x] 每页消息与检查点在同一成功边界提交；中途退出或重启从已提交检查点续读，不重复也不跳过。
- [x] 总开关关闭、绑定撤销后停止新增读取并保留已提交检查点；读取不占用单一全局无界事务。
- [x] 空结果、本机历史删除、缺消息表、CLI 异常输出分别形成不完整或失败状态，不能标记完整，也不能用空结果冒充完成。
- [x] 状态接口按绑定输出覆盖状态、原因、计数与时间等元数据，不含正文；真实 PostgreSQL 与 scripted CLI 的合成集成测试通过。

## Comments

2026-10-23：实现完成。新增迁移 `104_cli_history_sync_state.sql` 与 `persistence/history_sync_state.py`，按 `owner_id + contact_id + binding_id` 保存 `syncing` / `complete` / `incomplete`、启动时固定的 `watermark_at`、检查点、计数和时间；行不存在即“尚未开始”。`CliBackgroundSync` 新增历史状态端口与授权端口，只有授权端口明确允许时才为 active 绑定创建任务；授权版本本身由 [04](04-history-authorization-upgrade.md) 实现，生产装配暂不注入，因此老授权继续只走增量，不会静默读取历史。

历史读取复用票 02 的 `tail(..., history=True)` 有界分页。每页通过 `record_batch_with_messages` 在**同一事务**写入 `cli_history` 观察来源、规范消息和历史检查点；中间页不推进增量游标。完成页（`has_more=false`）在游标确实前移时于同一事务定位增量游标并标记可靠；已有更靠前的游标时保留原位置，完成页也不能作为可靠水位回退它。重启从持久化 `last_cursor` 续读；总开关关闭或绑定撤销后停止 CLI 读取且保留检查点。空结果、`local_history_deleted`、缺表（`cli_message_table_missing`）、freshness 未知和异常输出分别落为 incomplete，不能标记完整。状态 API 新增 `cli_history_coverages`，按绑定输出阶段、原因、计数、游标和时间，不含正文、昵称或备注。

历史页不逐条发布 `message_created` 事件：首绑历史可能很大，逐条唤醒会形成无界提取与界面更新；消息和来源已提交，提取回执仍由既有 `record_messages` 在事务内按队列阈值排队，分层由 [07](07-memory-extraction-layering.md) 处理。历史重试退避与多绑定公平调度是 03 引擎的恢复底座，界面与优先调度由 [05](05-multi-binding-scheduling-and-coverage-ui.md) 继续。

两轴评审：Standards 初审 13 项，采纳并修复共享退避提取、完成页游标回退防护、覆盖阶段枚举、缓存字段命名、页面失败分类抽取；保留长方法（单页事务内聚）与授权端口默认关闭（04 的边界）。Spec 初审 8 项，采纳并修复：完成不再按 `create_time` 穿过水位提前结束（只在 `has_more=false` 时完整）、历史页不再逐条发布事件、完成页游标只前进不回退、计数注释澄清；文件导入重叠补充了真实 `PostgresIngestRepository` 用例。

顺带修复票 02 集成测试暴露的既有问题：`request_safety_sweep()` 现在清除补齐/历史退避，手动检查可立即重试失败绑定。该失败在本票创建测试库前从未运行，已在 HEAD 的临时工作树复现确认属于旧缺陷。

## Answer

实现后的行为：

- 授权绑定首次同步从本机可读最早点分页；120 条合成文字经 3 页全部可检索，重启后从 `local_id:50` / `local_id:100` 续读，重复心跳不重复写入；完成后 `cli_history` 来源 3 条，最后一条与增量游标同事务可靠提交。
- 历史读取期间插入的新消息（第 101 条）进入同一分页与来源链，最终只出现一次；已有增量游标、LIVE 来源重叠和真实文件导入来源都不阻断历史读取，重叠消息只保留一个规范消息并增加来源引用。
- 每页失败（检查点写入异常）整页回滚：消息数为 0、检查点不变；退避后从同一页重试成功。空结果、`local_history_deleted`、缺表和异常输出分别得到 `history_empty` / `local_history_deleted` / `cli_message_table_missing` / `cli_output_invalid` 等不完整原因，`completed_at` 保持为空。
- 总开关关闭与绑定撤销后不再调用历史分页，已提交检查点保留；完成后的普通心跳不会把已更靠前的增量游标回退。
- 状态输出按绑定包含 `phase`（`not_started` / `syncing` / `complete` / `incomplete`）、`failure_code`、消息/非文字计数、页数、游标和时间；不含正文。

验证命令与结果：

- 红：新增单测在实现前因 `notalone.persistence.history_sync_state` 缺失失败。
- `python -m unittest tests.unit.front_sync.test_cli_history_sync`：15 项通过。
- `python -m unittest tests.unit.front_sync`（discover）：248 项通过。
- `NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_test python -m unittest tests.integration.persistence.test_cli_history_sync`：9 项通过（真实 PostgreSQL、正式迁移、生产适配器与 scripted CLI）。
- `python -m unittest tests.integration.persistence.test_observation_store tests.integration.persistence.test_cli_pagination_sync tests.integration.server.test_sync_api`：50 项通过。
- `tests.integration.persistence.test_database_migrations.DatabaseMigrationCommandTest.test_all_repository_migrations_install_and_repeat`：1 项通过（含 104 重复执行）。
- `tests.integration.server.test_binding_consent`：6 项通过。
- 全量：`NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_test python -m unittest discover -s tests -t .` 共 4904 项，138 failures / 76 errors / 3 skipped，失败模块与票 03 改动无关：47 个 setUpClass 因概览测试要求 `NOTALONE_DATABASE_URL == NOTALONE_TEST_DATABASE_URL` 且显式 `NOTALONE_EXPECTED_TEST_DATABASE` 而按设计拒绝；其余集中在记忆/SDK/任务评测等模型相关用例。抽样在 HEAD 临时工作树复现（`tests.unit.memory_extraction.test_merge_batch_timeline`、`tests.unit.skills.test_learning_materials`、`tests.integration.persistence.test_merged_migration_history`），确认属于既有失败；票 03 触碰的 front_sync、observation_store、sync_api、cli_history_sync 模块全量运行中无失败。

数据处理影响与剩余风险：

- 本机 PostgreSQL 将新增每绑定历史覆盖元数据（不存正文）；历史正文沿用既有消息、来源、删除和检索链路，消息量会显著增加。
- 本机已创建并迁移 `notalone_test`（001–104），供后续票复用；真实微信、全量历史规模、重启恢复和 24 个自定义账号会话留给 [08](08-real-wechat-acceptance.md)，未读取真实聊天。
- 生产装配暂未注入历史授权端口，因此本票交付的是“已授权绑定”的引擎能力；应用内首次全量读取需 04 接线后才发生。
- 历史页不逐条发布消息事件，关系提取分层由 07 验收；本票不宣称提取已按新规模完成验证。
