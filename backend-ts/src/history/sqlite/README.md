# SQLite 首次历史与消息合同（实施03）

`contracts.ts` 是后续07/11/16的稳定入口。`HistoryChannel` 是唯一外部替换边界：结构支持认证、固定目标、分页读取分别执行；未认证真实渠道不能读取正文。合成渠道仅替换此边界，正式身份服务、规范化、具名事务和SQLite均不替换。

`message` 的内部id与来源出现键、服务端别名、续读cursor各自独立。来源出现键包含来源代次、分片、表实例及精确十进制localId；serverId为0不建立别名。只有支持档明确 `serverAliasSemantics=verified_within_scope` 时才使用服务端别名连接不同本地身份；未知或不支持时保留观测值而不凭正文、时间或相同serverId猜测合并。message_alias使用内部id作为清理主键，完整scope+scheme+external_key仍有唯一约束，长复合出现键不会挤入删除目标键。`capture_record` 直接引用实际规范消息；每次重新读取产生新捕获，原执行引用的record不改写。非文字正文始终NULL，不下载媒体或调用模型。

服务读取提供 `HistoryRead`，含消息、实际来源record及覆盖；`running/not_started` 阻止生成，`incomplete` 要求每次请求明确确认并保留警告，不能把确认保存为永久偏好。未知顺序只提供稳定展示，不代表真实先后。后续派生域必须以完整 `(owner_id,contact_id,record_id,message_id)` FK 引用实际来源，不能从当前来源替换过去执行输入。

迁移由 `historyMigration(version)` 生成，版本仅由公共registry串行决定。03领域删除注册导出 `historyDeletionDomain`；`source(contactId,recordId)` 返回原捕获的不可变实际来源及当时支持档，隔离记录不从此入口提供给派生服务。`capture_record.availability` 在删除fence时立即失效；`source.ts` 的 `assertSourceEligibility(tx,MessageSourceReference)` 要在派生写者自己的接受事务复验，配合其运行/联系人代次，不能只检查先前读到的sourceRecordIds。

写者接受页时复验02 `assertReadEligibility`、固定goal、游标及数据代次。03没有库外文件；其他媒体、追踪和运行时消费者仍须各自注册，显式requiredDomains缺失不能完成删除。源删除的sourceId指capture_record.id；删除单个来源时保留其他合法来源支持的消息，最后来源删除才清除消息与别名；同一出现键持久抑制，不能因重读复活。清空全部聊天的精确渠道截断由06提供，缺失时scope_suppression保持blocked并关闭后续读取，不能宣称清空完整。

宿主在关闭同步、撤销及退出时调用 `stop/close` 并等待释放，不能只停止后续调度。

宿主必须给 `SqliteHistoryService` 与 `DeletionService` 传同一个 `ActiveHolders`，来源目标携带实际读取goal的holderKeys。关闭/删除等待查询终结及finally释放；忽略取消的渠道会使删除超时受阻，不能仅abort后completed。

本次实际制品的三值证据在 `support-profiles/wechat-4.0.6-29387.json`；该静态档仍unverified且不能自动替代运行时匹配，详见docs/verification/sqlite-private-history-support-03.md。


`FirstHistoryCoordinator` 是03首次历史的唤醒层，依赖受控 `directory` 与正式 `SqliteHistoryService`。`wake()` 后台合并请求，最多两位联系人并发；只处理有效授权下尚未完整的首次覆盖，不做持续增量、轮询、记忆或媒体。`stop(contactId?)`、`close()` 等待真实渠道返回及关闭；`getState()` 只返回固定状态和脱敏错误，`waitForIdle()` 供诊断及验收。正式宿主在成功启动并发布握手后、逐人确认成功及开启读取后唤醒；确认 HTTP 不等待整批历史。全局关闭同时停止首次历史和微信媒体读取，保留合法本地转换；撤销按联系人停止全部读取。退出先排空协调器，再沿共享领域关闭合同处理消费者、模型与SQLite；失败保留共享资源供原操作重试。

重开按原目标与游标恢复；来源不承认旧游标时保存真实不完整和最新失败原因，不清零为完整。首次派发已由正式 SQLite／联系人／历史服务验证，公共宿主触发与实际 App 验收仍单独记录。来源删除的 `coversAllSources` 只给可能持有该联系人任意来源的早期历史读者声明；按旧数据代次排空，不从已有 goal 猜测当前内存读者。

公共接线已有正式 HTTP 与 launchDsh/profile 合成验证：无消息／goal 预植，正常授权后自动首次入库，持久开关下启动自动派发；未知支持零 target/page 并显示最新受阻原因。状态只覆盖显示层错误，不伪造持久 goal、完整覆盖或正文可用性。实际 App 的消息、覆盖及删除后正文撤下仍需独立桌面证据。

开发窄客户端另有 `observeTestMetadataSelected('arm'|'next'|'current')`：一次基线、逐阶段唯一 owner/text 新行、最多两条，复查只用内部已锁主键。错误终止观察并排空，不重试改变时序关联；未知状态不放行正常历史。真实 UI 发送成功不能代替状态语义认证。

`createWechatHistoryChannel(executable?)` 使用显式工具路径及固定旁侧 manifest，经正式窄客户端核验制品和支持档。实例绑定账号、稳定会话键及完整读取 token；任一范围字段变化关闭读者。未配置或支持未认证时拒绝正文，不自动寻找工具。原生 target／cursor 只属于签发它的固定快照进程，失效时保留 incomplete 和明确错误，不把新快照冒充旧游标续读。公共宿主须传入受控配置路径；真实支持状态仍按运行时报告。

联系人窄元数据与正文资格分开：工具配置账号按固定版本／完整 contact、SessionTable 结构／可读性及前后配置和来源守卫核验，账号 generation 与稳定私聊 resolve 共用来源公式。名单只在服务明确同意后读取必要私聊字段；未知支持、重复或缺失拒绝。metadata verified 不授权正文，也不表示前台登录核验。端口失败排空旧客户端，后续显式重检可重新核验，不能恢复旧授权。
