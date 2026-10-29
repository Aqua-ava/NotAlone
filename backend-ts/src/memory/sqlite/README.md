# SQLite固定范围记忆处理（07）

## 共享执行和实际追踪合同

`schema.ts`导出`memoryExtractionMigration(version:number)`，`execution-schema.ts`导出`memoryExecutionMigration(version:number)`。公共宿主已注册discussion v7、memory v8、execution v9，保留media v6；已发布v1–v9不可改写，后续只追加增量迁移。所有时间为毫秒，整数由Worker读为bigint。领域动作不暴露任意SQL。

07拥有`processing_run/run_contact/processing_item/run_input/processing_task/task_contribution/processing_step/step_input/step_attempt`以及通用`model_operation/operation_item/model_call/execution_event/execution_input/event_source`。记忆producer的`model_call`必须沿operation关联同一个step，event的原始call必须属于同attempt，实际input必须指向同step冻结输入，event_source必须在该步固定窗口内。来源固定引用`capture_record.id`，不是文本或旧PG来源ID。

11拥有已组合的讨论/回复父合同。共享表以互斥producer分支关联真实reply_request/reply_attempt/reply_context，约束实际材料、来源、原始call与助手正文；`reused_call_id`仅可复用同operation的已知成功回执，不创建第二次物理调用。来源删除的记忆分支由07负责，讨论分支由11的`discussion_calls`负责，清理后才删除各自父件。quality、正式候选/版本、文档等未开放分支由对应票增量加入。

点击固定集合`run_input`与实际执行子集`execution_input`分开，完整载荷及其全部传递来源在`execution_event/event_source`。过程正文不写普通日志。正式`memory_candidate`及memory/version/decision由08建立；07的verified_output仅是具有真实producer、逐项核验和冻结来源的不可变阶段产物，不能当作已经采纳的记忆。自动来历为auto，主题/概览未运行，整轮保持未完成。

本合同初次仅证明DDL与存储重开；业务、删除和桌面证据在本票Answer按实际执行补齐，不能把结构通过当作渠道认证。


## 领域接入

`service.ts`的`SqliteMemoryExtraction`绑定宿主owner，`start(requestKey)`只消费已保存资料，并异步执行固定目标；`pause/continue/read/trace/waitForIdle/close`不调用微信。`initialize()`只恢复状态，不重发模型。普通暂停在小批边界收尾；撤销和来源删除在每次发送与提交的同一短事务复验。`model-port.ts`沿原正常提取提示、complete-claim-v1核验策略和唯一ModelHost，禁自动HTTP/流程重试；`runtime.ts`供公共宿主组合，未配置时保留可见失败，不能隐式换供应商。宿主须注入llm并复用现有环境加载，不能因为工厂存在声称已经产品接线。

多业务宿主先装配唯一ModelHost和provider，再将同一provider与permit传给`createSqliteExtractionModelPort`；同时向讨论传相同provider和该ModelHost的arbiter。提取端口`close`只取消并排空自己调用，不释放注入的共享provider；宿主须在记忆、讨论等所有调用者排空后统一dispose。未注入provider时，端口沿独立装配路径自行安装并释放，不能与另一个同名adapter并行装配。

公共宿主调用`createSqliteMemoryRuntime`时注入`sharedModel: {configuration, provider, permit, resolveUserId}`。此分支只使用共享许可端点及adapter，匿名身份已由provider绑定，不另建ModelHost、arbiter、身份目录或provider，也不持有其关闭能力；close只排空本service。configuration必须来自宿主安全读取既有env文件后的正常解析，`NOTALONE_ENV_FILE`仅是路径，解析器不会自行加载。未注入的独立测试路径才自行安装/关闭资源。

物理调用回执`ModelLedgerReceipt`没有purpose字段；用途通过真实`model_operation.purpose`和step生产者关系核验。07的accounting.reserve/recordReserved使用具名动作复验owner、call、请求及claim，不接受讨论调用；unconfirmedRequests仅返回extraction/verification。11自行提供discussion的具名未知查询，由唯一宿主合并，无需第二账本。官方provider请求purpose继续保持undefined，不能把领域用途塞入SDK协议。

`http.ts`提供`SqliteMemoryExtractionHttp(service,authorize)`：认证POST `/api/memory-processing/runs`仅接受UUID `request_key`，GET `/runs/current`与`/runs/:id`读取固定轮次；POST `/runs/:id/pause|continue`仅空对象；GET `/tasks/:id/events`读取独立可删除追踪。owner、SQL、来源子集及任意模型配置均不接受HTTP输入，Origin拒绝，响应no-store。

`outputs.ts`导出`verifiedExtractionOutput(tx,{ownerId,eventId})`，08在正式候选提交的同一短事务内调用。返回真实`producedAttemptId/outputNo`、scope、原fact、auto来历和全部实际来源。本人产物由独立self attempt产生，通过`execution_input`的`verified_contribution`事件材料分支，以同owner复合外键引用原联系人窗口的`verified_self_contribution`事件，并同时保存实际消息窗口和全部来源；不改写事实、不作裁决、不冒充用户确认。

`registration.ts`提供本写者的精确`memoryExtractionDeletionAuthority`和`memoryExtractionDeletionRegistration()`。本分支显式装配memory_extraction→history→identity→skill_metadata，只开放实际source/contact/account；清空边界由06接续。公共宿主每增加讨论/媒体等真实写者都必须扩requiredDomains和精确authority，不能把本分支当作完整产品注册。`deletion.ts`来源闭包覆盖固定输入、实际前文和本人混合阶段；source保留封存无正文调用及原范围，contact/account连同此前封存调用清除。

活动调用登记`memory:${taskId}`到与05相同的ActiveHolders，关闭回调取消并等待真实业务finally与末次写入。正常关闭共享同一Promise，等待已受理的SQLite准备、所有在途任务及模型端口；claim或代次读取晚返回时先检查停止状态，不能继续派发。释放失败仅清除关闭缓存供原对象重试，业务停止信号不恢复；成功关闭结果仍复用。原始资料、规范消息和外部微信不由本模块读写；完整追踪只进SQLite，不进普通日志或Git。

`contracts.ts`给11提供已实现producer/input分支的TypeScript合同。每个工厂独立接收version，公共registry使用已发布的7/8/9组合；后续不可改写这些版本。本人阶段复用既有事件材料，不新增产物身份或正文表，旧owner工厂已删除。
