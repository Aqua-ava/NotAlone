# SQLite 首次历史与消息合同（实施03）

`contracts.ts` 是后续07/11/16的稳定入口。`HistoryChannel` 是唯一外部替换边界：结构支持认证、固定目标、分页读取分别执行；未认证真实渠道不能读取正文。合成渠道仅替换此边界，正式身份服务、规范化、具名事务和SQLite均不替换。

`message` 的内部id与来源出现键、服务端别名、续读cursor各自独立。来源出现键包含来源代次、分片、表实例及精确十进制localId；serverId为0不建立别名。message_alias使用内部id作为清理主键，完整scope+scheme+external_key仍有唯一约束，长复合出现键不会挤入删除目标键。`capture_record` 直接引用实际规范消息；每次重新读取产生新捕获，原执行引用的record不改写。非文字正文始终NULL，不下载媒体或调用模型。

服务读取提供 `HistoryRead`，含消息、实际来源record及覆盖；`running/not_started` 阻止生成，`incomplete` 要求每次请求明确确认并保留警告，不能把确认保存为永久偏好。未知顺序只提供稳定展示，不代表真实先后。后续派生域必须以完整 `(owner_id,contact_id,record_id,message_id)` FK 引用实际来源，不能从当前来源替换过去执行输入。

迁移由 `historyMigration(version)` 生成，版本仅由公共registry串行决定。03领域删除注册导出 `historyDeletionDomain`；`source(contactId,recordId)` 返回原捕获的不可变实际来源及当时支持档，隔离记录不从此入口提供给派生服务。`capture_record.availability` 在删除fence时立即失效；`source.ts` 的 `assertSourceEligibility(tx,MessageSourceReference)` 要在派生写者自己的接受事务复验，配合其运行/联系人代次，不能只检查先前读到的sourceRecordIds。

写者接受页时复验02 `assertReadEligibility`、固定goal、游标及数据代次。03没有库外文件；其他媒体、追踪和运行时消费者仍须各自注册，显式requiredDomains缺失不能完成删除。源删除的sourceId指capture_record.id；删除单个来源时保留其他合法来源支持的消息，最后来源删除才清除消息与别名；同一出现键持久抑制，不能因重读复活。清空全部聊天的精确渠道截断由06提供，缺失时scope_suppression保持blocked并关闭后续读取，不能宣称清空完整。

宿主在关闭同步、撤销及退出时调用 `stop/close` 并等待释放，不能只停止后续调度。

宿主必须给 `SqliteHistoryService` 与 `DeletionService` 传同一个 `ActiveHolders`，来源目标携带实际读取goal的holderKeys。关闭/删除等待查询终结及finally释放；忽略取消的渠道会使删除超时受阻，不能仅abort后completed。
