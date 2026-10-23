# 关系资料处理与消息历史分层

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 03

按 [spec](../spec.md) 与 [ADR-100](../../../architecture/adr/100-authorized-private-history-sync.md)，历史消息入库后即可作为关系提取的合法来源，但提取是独立、异步、可恢复的派生任务，不阻塞历史同步或首次使用，也不在首次入库时无界批量执行。界面分别表达“消息历史覆盖”和“关系资料处理”。

## 验收

- [x] 历史消息入库不等待关系提取；提取任务独立排队、限流、可恢复，积压或失败不改变消息覆盖状态。
- [x] 历史消息作为提取来源时保留来源引用；来源删除、绑定撤销或联系人删除后，相应提取失效且不可再检索。
- [x] 首次历史入库不触发无界批量提取；提取按现有队列约束推进。
- [x] 界面分别显示消息历史覆盖与关系资料处理，不合并成“记忆已同步”一类状态。
- [x] 队列、失效与界面状态的测试覆盖。

## Comments

2026-10-23：实现完成。

历史页仍通过既有 `record_messages` 在同一事务写入提取回执，不逐条发布事件、不创建任务。新增迁移 `106_extraction_queue_pending_index.sql`，为 `memory_extraction_receipt(owner_id, contact_id, observation_id) WHERE task_id IS NULL` 建部分索引；`record_messages` 改为 `count(*)`，历史页提交不再按积压规模物化回执行。`claim_scope` 单次最多登记 2000 条回执并按来源批次顺序推进；活动任务未完成目标达到 2000 时先不追加、保留 `due_at`，积压由调度器下一轮继续；同一来源批次余下的回执随本次认领归入任务，避免空任务。既有小批量合并行为保持不变。

`PostgresMemoryProcessingStore.targets` 每次运行最多选 200 个目标，上下文限制在 600 条消息加前后各 20 条；`PostgresMemoryExtractionRunner.run` 对任务目标逐批提交回执与水位后继续，进程中断后从剩余目标恢复。模型窗口仍受既有 10 条目标/20 条上限约束；任务轮次由认领上限约束，不会把整段历史装进单次任务。

目标和上下文共用 `_source_validity_sql`：导入任务只接受该来源仍 active 的消息，观察任务只接受 `memory_enqueued_at` 已登记且有 active 绑定的来源。绑定撤销后既有目标不再被选中，重新确认联系人也不会复活旧任务目标；来源删除与联系人删除沿用既有派生清理与级联，并新增消息来源引用、回执、目标和已确认记忆清失验证。已完成记忆不因撤销删除：原始消息按 ADR-089 保留，撤销停止读取与后续提取。

`/api/memory/processing` 读取新增 `pending_count`，只统计 active 绑定下尚未排队的回执；本人范围按 owner 汇总。桌面桥接透传该字段，记忆页卡片改名为“关系资料处理状态”，明确“不代表消息历史覆盖是否完整”，待处理积压单独显示；`聊天资料的关系提取` 取代“同步聊天资料”。

`test_merged_migration_history` 改为按既有历史推导 baseline 之后的迁移清单，兼容 104–106；该用例在票 03 加入 104 后已失败，本票一并修复。

验证：

- 新增 `tests.integration.persistence.test_history_memory_layering` 9 项通过：历史页只入队不建任务、既有批量认领与有界执行、2000 条积压上限与续领、目标/上下文上限与恢复、提取失败不改覆盖、来源/联系人删除清失记忆与提取状态、撤销绑定后目标失效、本人积压汇总。
- 相关模块 77 项通过：`test_cli_history_sync`（含票 04 新增用例）、`test_observation_task`、`test_memory_processing_read`、`test_memory_processing_progress`、`test_merged_migration_history`、`test_runtime_execution`、`test_bounded_stage_profile`。
- 桌面 `npm test`：934 项，933 通过、1 跳过、0 失败；`tests/memory-processing/react.test.mjs` 新增分离与积压用例通过。既有 `可见页面按真实进展更新记忆` 在 HEAD 基线同样失败，非本票引入。
- `test_observation_auto_flow` 20 项中有 6 项失败；在仅保留票 04 工作树改动的基线上同样 6 项失败（配置恢复、失败轮次、同秒批次、无日期水位），非本票引入。
- 全量单测 2619 项：14 失败/6 错误，集中在既有 `test_merge_batch_timeline`、`test_upgrade_transaction_ports`、`test_review_sdk_transport`、`test_learning_materials` 与 experiments 加载失败，与票 03 记录的既有失败类别一致。

两轴评审：Standards 采纳合并统计按 dataclass 字段、抽出共享 `run_extraction` 参数、先查活动任务再扫回执、共享来源有效性、测试 helper 去重、去掉重复积压文案；保留 `claim_scope` 承担调度背压（判断项）和读取投影为单语句而保留的 CTE/回退同构 SQL。Spec 采纳撤销来源不再进入目标、活动任务满额时不再重复扫描、补测联系人删除后记忆清失；明确保留“撤销不删原始消息与已完成记忆”的既有边界，真实规模留给 08。

## Answer

- 历史页入库后只写消息、来源和提取回执；不会启动关系提取，也不改变消息覆盖。回执按既有阈值排队，新增部分索引后历史页事务不再随积压规模变慢。
- 提取在独立观察任务中按 200 个目标、至多 600 条上下文一批运行，逐批提交回执与水位；模型窗口不超过既有 20 条目标上限。任务暂停、失败或积压时 `cli_history_sync_state` 的 phase、计数和游标保持不变。
- 单次认领最多登记 2000 条回执；活动任务未完成目标达到 2000 时不再追加，余量保留为到期工作。因此每个任务轮次有界，历史规模不会进入一次无界批量。
- 历史来源保留 `message_source_ref -> local_wechat_observation` 引用；提取来源 ID 指向规范消息。来源删除后孤儿消息、回执、目标与相关记忆一并清理；联系人删除级联清除任务、回执、目标和已确认记忆；绑定撤销后新回执不进入队列、既有目标不再被选中，重新确认也不会复活。
- 记忆页使用“关系资料处理状态”，明确不代表消息历史覆盖；`pending_count` 显示尚未排队的聊天量，本人范围按 owner 汇总。消息历史覆盖界面仍由 [05](05-multi-binding-scheduling-and-coverage-ui.md) 提供，本票不合并两者。
- 数据处理影响：新增每联系人提取调度元数据、部分索引与界面待处理计数；不复制聊天正文，不新增外部模型调用类型，不改变消息层存储。已撤销绑定的原始消息按 ADR-089 保留，已完成记忆不因撤销删除。
- 剩余风险：真实全历史规模、真实 App 与重启恢复留给 [08](08-real-wechat-acceptance.md)；`test_observation_auto_flow` 的 6 项失败在票 04 工作树基线上已存在，独立于本票；迁移编号 105 由票 04 使用，106 为本票部分索引。
