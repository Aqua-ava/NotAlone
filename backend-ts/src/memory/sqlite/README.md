# SQLite固定范围记忆处理（07）

## 共享执行和实际追踪合同

`schema.ts`导出`memoryExtractionMigration(version:number)`。当前注册暂用v6，未进入统一分支前由集成者按顺序分配；已发布v1–v5不改。所有时间为毫秒，整数由Worker读为bigint。领域动作不暴露任意SQL。

07拥有`processing_run/run_contact/processing_item/run_input/processing_task/task_contribution/processing_step/step_input/step_attempt`以及通用`model_operation/operation_item/model_call/execution_event/execution_input/event_source`。当前只开放真实存在的记忆producer；`model_call`必须沿operation关联同一个step，event的call必须属于同attempt，实际input必须指向同step冻结输入，event_source必须在该步固定窗口内。来源固定引用`capture_record.id`，不是文本或旧PG来源ID。

11拥有讨论/回复父合同。11/12扩展真实reply producer时，应另加增量迁移和互斥CHECK/同call约束；不要在07引用尚不存在的未来父表，也不要创建第二套调用/追踪表。quality、正式候选/版本、文档等未开放分支由对应票增量加入。

点击固定集合`run_input`与实际执行子集`execution_input`分开，完整载荷及其全部传递来源在`execution_event/event_source`。过程正文不写普通日志。正式`memory_candidate`及memory/version/decision由08建立；07的verified_output仅是具有真实producer、逐项核验和冻结来源的不可变阶段产物，不能当作已经采纳的记忆。自动来历为auto，主题/概览未运行，整轮保持未完成。

本合同初次仅证明DDL与存储重开；业务、删除和桌面证据在本票Answer按实际执行补齐，不能把结构通过当作渠道认证。
