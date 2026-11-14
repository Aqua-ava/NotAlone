# SQLite 固定范围记忆处理

产品合同以[记忆处理](../../../../architecture/current/memory-processing.md)、[执行追踪](../../../../architecture/current/memory-extraction-trace.md)为准；本页只保留本模块的接口、装配和故障处理。

## 共享执行和实际追踪合同

`schema.ts`导出`memoryExtractionMigration(version:number)`，`execution-schema.ts`导出`memoryExecutionMigration(version:number)`。公共宿主已注册discussion v7、memory v8、execution v9，保留media v6；已发布v1–v9不可改写，后续只追加增量迁移。所有时间为毫秒，整数由Worker读为bigint。领域动作不暴露任意SQL。

本模块拥有`processing_run/run_contact/processing_item/run_input/processing_task/task_contribution/processing_step/step_input/step_attempt`以及通用`model_operation/operation_item/model_call/execution_event/execution_input/event_source`。记忆producer的`model_call`必须沿operation关联同一个step，event的原始call必须属于同attempt，实际input必须指向同step冻结输入，event_source必须在该步固定窗口内。来源固定引用`capture_record.id`，不是文本或旧PG来源ID。

共享调用表以互斥 producer 分支关联真实 `reply_request/reply_attempt/reply_context`，约束实际材料、来源、原始 call 与助手正文；`reused_call_id` 仅可复用同 operation 的真实既有调用。记忆裁决、文档和回复扩展由各领域迁移及公共 registry 组合；不能伪造未安装的父表或用同名字段代替真实外键。

请求固定集合 `run_input` 与实际执行子集 `execution_input` 分开，完整载荷及其传递来源保存在 `execution_event/event_source`，过程正文不写普通日志。提取核验通过的原稿经 `verifiedExtractionOutput` 交给管理域；采纳、裁决和主题／概览发布由后续领域执行，提取完成不等于所有阶段完成。候选级内容拒绝与正常跳过可以结束为 `no_new_memory`；技术或整轮协议故障保持受阻，详见现行记忆处理合同。

## 领域接入

`service.ts`的`SqliteMemoryExtraction`绑定宿主owner，`start(requestKey)`只消费已保存资料，并异步执行固定目标；`pause/continue/read/trace/waitForIdle/close`不调用微信。`initialize()`只恢复状态，不重发模型。普通暂停在小批边界收尾；撤销和来源删除在每次发送与提交的同一短事务复验。`model-port.ts`沿原正常提取提示、complete-claim-v1核验策略和唯一ModelHost，禁自动HTTP/流程重试；`runtime.ts`供公共宿主组合，未配置时保留可见失败，不能隐式换供应商。宿主须注入llm并复用现有环境加载，不能因为工厂存在声称已经产品接线。

多业务宿主先装配唯一ModelHost和provider，再将同一provider与permit传给`createSqliteExtractionModelPort`；同时向讨论传相同provider和该ModelHost的arbiter。提取端口`close`只取消并排空自己调用，不释放注入的共享provider；宿主须在记忆、讨论等所有调用者排空后统一dispose。未注入provider时，端口沿独立装配路径自行安装并释放，不能与另一个同名adapter并行装配。

公共宿主调用`createSqliteMemoryRuntime`时注入`sharedModel: {configuration, provider, permit, resolveUserId}`。此分支只使用共享许可端点及adapter，匿名身份已由provider绑定，不另建ModelHost、arbiter、身份目录或provider，也不持有其关闭能力；close只排空本service。configuration必须来自宿主安全读取既有env文件后的正常解析，`NOTALONE_ENV_FILE`仅是路径，解析器不会自行加载。未注入的独立测试路径才自行安装/关闭资源。

物理调用回执`ModelLedgerReceipt`没有purpose字段；用途通过真实`model_operation.purpose`和step生产者关系核验。本模块的 accounting.reserve/recordReserved使用具名动作复验owner、call、请求及claim，不接受讨论调用；unconfirmedRequests仅返回extraction/verification。讨论模块自行提供 discussion的具名未知查询，由唯一宿主合并，无需第二账本。官方provider请求purpose继续保持undefined，不能把领域用途塞入SDK协议。

`SqliteMemoryExtractionHttp(service, authorize)` 在 `/api/memory-processing` 下提供：POST `/runs` 和 `/contacts/:id/history` 仅接受 UUID `request_key`；GET `/runs/current`、`/runs/:id`、`/contacts/:id/current`、`/schedule` 和 `/tasks/:id/events` 读取当前状态与真实追踪。POST `/runs/:id/pause|continue` 要求非负安全整数 `action_version` 与 UUID `operation_id`，拒绝空对象和未知字段。owner、固定输入与执行资格由认证宿主及业务事务确定。

POST `/contacts/:id/complete` 只接受空对象，显式恢复该联系人已完成提取的原任务：仅裁决其 contact 范围候选，再执行并发布该 contact 的主题资料和长期概览。独立本人任务及其他联系人不进入这条执行链；默认自动整轮链保持原行为。该操作受记忆总开关、有效来源、暂停、未知回执及真实待确认门槛约束，异步进度仍从联系人状态和管理接口读取。手动调度下无需开启全局队列，也不通过修改时钟跳过自动整理窗口。

该完整收尾入口允许仅在指定联系人的旧裁决步骤明确失败、调用均为已结算的已知终态时重试；普通自动发布不因此重发失败调用，也不推进其他任务。分页裁决只在成功输出落盘后续期整个有效执行组，不恢复已过期或未知执行；重复进展不延长租约。重试新建调用并保留原账本，不宣称复用了旧回执。

主题和概览的已知失败也仅在显式联系人完整收尾时复验并重试，原冻结版本、来源与暂停门槛不变。旧失败步骤保留历史，发布仅采用各阶段最新执行。主题内容核验反馈最多触发一次同暂存空间修正，原回合及总调用预算共享，修正后仍须通过独立核验。

记忆自动处理总开关（[ADR-166](../../../../architecture/adr/166-memory-auto-processing-switch.md)）：`auto-processing.ts` 提供迁移 42 与 `memoryExtraction.readAutomatic|setAutomatic` 动作，开关存于 `database_instance.memory_auto_processing`，默认 0（关闭）。服务 `initialize()` 读入内存镜像，`start|startHistory|continue` 在关闭时抛 `memory_auto_processing_disabled`，`startContact|startHistoryBatch|recoverBacklog|resumeFollowups` 与 `launch` 在关闭时不建轮、不恢复；调度器经 `enabled()` 停止扫描，后续整理 worker 在关闭时不取到期阶段。`setAutomatic(false)` 对在途轮次施加内部暂停（步骤边界停止），`setAutomatic(true)` 只继续由它暂停的轮次。GET／POST `/api/memory-processing/automatic` 读取与设置，`/schedule` 附带 `automatic` 字段。测试夹具创建库后须显式开启（`memory-sqlite/support.mjs` 的 `automatic:false` 选项可保留默认关闭）。

`outputs.ts`导出`verifiedExtractionOutput(tx,{ownerId,eventId})`，管理域在正式候选提交的同一短事务内调用。返回真实`producedAttemptId/outputNo`、scope、原fact、auto来历和全部实际来源。本人产物由独立self attempt产生，通过`execution_input`的`verified_contribution`事件材料分支，以同owner复合外键引用原联系人窗口的`verified_self_contribution`事件，并同时保存实际消息窗口和全部来源；不改写事实、不作裁决、不冒充用户确认。

`registration.ts`提供本写者的精确`memoryExtractionDeletionAuthority`和`memoryExtractionDeletionRegistration()`。该最小工厂仅组合 memory_extraction → history → identity → skill_metadata，开放 source/contact/account；正常产品使用公共 `installedDeletionRegistration` 组合讨论、媒体、裁决、文档和聊天清空等全部实际写者。新增写者须同步扩 requiredDomains 与精确 authority，不能用最小工厂替代正式注册。`deletion.ts`来源闭包覆盖固定输入、实际前文和本人混合阶段；source保留封存无正文调用及原范围，contact/account连同此前封存调用清除。

活动调用登记`memory:${taskId}`到与统一删除相同的ActiveHolders，关闭回调取消并等待真实业务finally与末次写入。正常关闭共享同一Promise，等待已受理的SQLite准备、所有在途任务及模型端口；claim或代次读取晚返回时先检查停止状态，不能继续派发。释放失败仅清除关闭缓存供原对象重试，业务停止信号不恢复；成功关闭结果仍复用。原始资料、规范消息和外部微信不由本模块读写；完整追踪只进SQLite，不进普通日志或Git。

`contracts.ts` 向回复域提供已实现 producer/input 分支的 TypeScript 合同。迁移工厂独立接收版本，已发布 SQL 不可改写；公共 `registry.ts` 维护实际连续顺序。执行事件复用同一真实输入、调用及来源身份，不建立第二套正文或调用记录。

## 图文内容插件与调度

调度通过 `scheduleContacts` 获取当前有效联系人，再以 `scanSchedule(now, contactIds)` 每批最多 32 位返回历史到期与增量到期时间；一批共用同一轻量候选及可用性结果，不读取正文到宿主、不计算内容哈希。读取结果仅作短期调度提示；建轮仍在写事务内复验，启动、范围变化及每 30 秒兜底重新检查。联系人唤醒只重读该联系人，在途新增唤醒保留至下一轮；任务状态改变后重新读取，删除的联系人从提示中移除。

`schedule-inputs.ts` 的复用仅存在于一次同步只读动作，结束即释放；不跨写事务或重启保存资格。已分配目标通过一次构建的非空 item 集合判断，避免每条候选扫描同一 owner 的 `run_input`。既有冷却、历史轮转、每轮一个历史小批、未知回执及用户暂停规则保持。

[内容插件](../content/README.md)通过同一可信清单装配宿主与 Worker，追加迁移32冻结插件／文件身份，33保留旧文字引用并增加类型化内容引用。正常提取窗口将实际图片同时带入提取及来源核验；图片进度独立计数，未就绪与已清除图片不冒充成功目标。每批最多8张、原始总量32MiB，目标优先、上下文使用剩余额度。新模型路径不上传 Files API；实际模型请求图片的变换摘要进入可删除追踪。

图片清除和旧版本替换从冻结文件引用进入精确删除闭包，依次排空在途任务、清理记忆及文档／回复／运行记录，再清文件。合法新主图可重新排队，用户清除及未知调用不会因此自动恢复。策略恢复复制原冻结内容身份，不扩大输入。验证边界见[接线记录](../../../../docs/verification/pluggable-image-memory-20261103.md)。

阶段实现和旧验收记录已移至[开发历史](../../../../docs/history/backend-development-history.md)；历史数字不表示当前版本通过。
