# 03：持久观察调度对照

## 腾讯源码与 Python 适配
- 参考仓库固定 `TencentDB-Agent-Memory@e9a8293`，`MemoryCore/src/config.ts:681–683` 实际默认消息阈值为 5，开启预热，空闲时长为 600 秒；没有采用其他位置的 60 秒注释。
- `utils/stateful-pipeline-manager.ts:199–221,239` 原子捕获待处理输入并推进预热。本实现由观察与规范化消息写入同一事务创建消息身份 receipt，以 1→2→4→5 预热阈值触发，之后每 5 条触发；任一次有效派发（包含空闲派发）推进预热。
- `services/timer-scanner.ts:135–166` 扫描到期工作并原子认领。本实现 `persistence/extraction_schedule.py` 持久保存阈值、最新输入时间、待处理身份及派发代数；通知或每 2 秒补扫均经过现有联系人锁与同一事务认领。
- 腾讯计算 conversation/round，本产品以新插入的规范化消息计数；重复观察、重复事件不增加数量或延后空闲时间。删除来源后的身份在派发前重新核实，不提前触发。
- 扫描仅唤醒现有 `TaskHost`/`BackgroundTaskWorker`，不新增执行器；既有任务租约、联系人授权、模型优先级及停止行为继续生效。同步关闭禁止新读取；已有合法输入可继续整理。

## 正式入口及恢复边界
`observation_store._write_cli_messages` 原子记账 → `EventBusMessagePublisher` 通知 → `enqueue_observation_message` 检查到期后入队；`server.command.start_reading` 启动补扫，恢复丢通知及 queued/running/verifying 任务。已撤销绑定、已删除来源、其他 owner、取消任务和旧资料升级任务不会被扫描领取。未发生新输入的 failed 不复活；新输入到期沿用现有恢复 failed 规则。

历史导入仍由 HTTP commit 立即入队。迁移不回填旧聊天；关停不额外调用模型，未到期输入保留在数据库等待重启。记账仅保存身份与时间，不另存聊天正文。联系人/观察/消息删除经外键级联清理 receipt。

## 红绿与回归记录
使用工作树绝对 `PYTHONPATH=/tmp/notalone-tencent-python-scheduler/backend/src:/tmp/notalone-tencent-python-scheduler/backend` 与 Conda Python，隔离 PostgreSQL，模型使用合成边界。
- `tests.integration.server.test_persistent_extraction_schedule`：8 项通过，12.725 秒。阈值测试先暴露旧逐条派发；启动测试先暴露缺少恢复入口；删除测试先暴露陈旧计数提前派发，均完成对应修复后转绿。
- 覆盖数量触发、丢通知、空闲重启、幂等、来源删除、撤销授权、失败后仅新输入恢复、停止后不派发。

## 真实模型观察入口（未在本任务调用）
复用 `tests.integration.server.test_observation_auto_flow.ObservationAutoFlowFixture.record/publish` 的输入结构：在隔离库为合成 owner/contact 创建已确认 `PostgresConversationBindingRepository.create_binding`，通过 `PostgresObservationStore.record_batch_with_messages` 提交 `CLI_BACKGROUND` 合成消息，再将 `created_message_ids` 交给 `EventBusMessagePublisher.publish_message_created`；host 使用真实生产 worker/runtime factory，不使用 fixture 的 `ObservationModel` 或 `SyntheticSupportingVerifier`。启动 `host.start_scheduling(owner_id=...)`，先提交 1 条完成首次预热，再提交 1 条确认无提前派发，第三条达到阈值 2；下一条不足阈值时仅控制 `extraction_schedule.utcnow` 到最后输入后 601 秒，让同一 scanner 自行派发。通过 HTTP task/current-memory 和 L2/L3 当前状态断言，不直接入库候选或调用 worker，所有模型传输仍绑定同一个问题预算账本。

相邻验证：`test_observation_auto_flow` 的 replay/调度失败重试及 `tests.unit.application.test_import_service` 共 10 项通过；另 `test_committed_observation_automatically_processes_original_task` 的任务成功，但旧断言仍期待 1 条 pending candidate，现有默认自动采纳实际为 0，未在调度票修改该旧语义夹具。
