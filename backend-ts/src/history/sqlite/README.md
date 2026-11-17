# SQLite 历史消息与增量同步

产品合同以[微信同步](../../../../architecture/current/wechat-sync.md)、[来源删除](../../../../architecture/current/privacy-deletion.md)为准；本页只保留本模块的接口、装配和故障处理。

`contracts.ts` 是记忆、回复和媒体消费者的稳定入口。`HistoryChannel` 是唯一外部替换边界：结构支持认证、固定目标、分页读取分别执行；未认证真实渠道不能读取正文。合成渠道仅替换此边界，正式身份服务、规范化、具名事务和SQLite均不替换。

`source-proof.ts` 统一读取、核对与更新每联系人唯一的来源事实；`continuity.ts` 负责来源元数据判据与受控接纳。迁移46已移除旧围栏、范围和租约三表。原生守卫与Worker易失资格只保护本轮独占读取，提交前复验，成功、失败或取消后等待真实释放；不停车保留空闲联系人守卫。消费者读取合法本机资料核对 `source_proof`，新外部正文读取另须本轮守卫，重启不恢复运行资格。

按 [ADR-177](../../../../architecture/adr/177-retire-source-recertification-and-cleanup.md)退役重新认证、取消、批量修复和副本清理请求流程。迁移47将必要已验证的遗留删除等价事实保存在 `history_source_equivalence`，区分表前缀范围与逐键点范围，仅用于删除闭包与未来抑制。合法保留的旧消息、捕获来源和引用归属不改写；这些事实不构成读取授权或普通消息别名，并随联系人或账户删除。旧版本迁移SQL与校验和不改写，未完成旧副本清理阻止升级并保留现场。

`SqliteHistoryService` 的 `HistoryLease` 统一承载本轮范围、渠道、守卫与删除持有者；不保留跨轮联系人通道、停车状态或空闲守卫。成功、失败与取消都等待真实守卫释放和渠道关闭；关闭失败的读者仍留在 `active`，停读、删除及下一次共享租约先重试排空。守卫释放事务失败时先关闭存储，未确认的存储或渠道关闭继续阻止删除完成，不重复发送失败的守卫写入。

当前读取器实际 `resumeTarget` 成功后，才把原 `goalId + cursor + target` 作为本轮可信来历交给守卫准备事务。事务重新核对原目标、完整授权与代次、支持档及原游标范围摘要，并确认返回目标仅为同结构的新快照，才保留原持久恢复点事实；原生每轮分配的新 descriptor 不代表物理来源变化。它不授予直接 tail：同步必须读取本轮差异 page，终页原子交接后才能 tail，旧 goal 的 target 从不改写。同授权、支持档和目标结构下，已实际接受终页且完整遍历、仍含未知行的历史事实保留原 incomplete／quarantine 状态；原失效 SQL 内完成判定，不把来源准备变成历史池重验。`ensureSourceReady` 复用受控恢复入口，不读 page／tail、不创建或推进同步目标。

本轮替代的终页或受控检查点被事务接受、且读者真实关闭成功后，才定向退役已被替代的空增量及其完整空历史父目标，使同源空闲轮不累积无用目标。任意 `capture_record`（含隔离或排除记录）、恢复操作或后继依赖均阻止退役，未知或未完历史不参与清理；页失败、取消或关闭失败保留原恢复点。来源、授权、支持档或真实目标结构变化仍按原围栏／交接处理，普通会话内游标不跨租约。

历史首次读取与增量恢复交接共用有界历史页循环。读取器声明持久历史检查点时按片段释放；仅支持持久增量检查点的旧读取器在同一租约读到历史终页再接增量。`synchronizeIncremental` 只维护这一条能力和恢复证明决定的执行路径，不接受旧 `followHistoryHandoff` 策略开关。共享原生进程继续复用；高层不直接打开、修改或关闭微信原始 DB／WAL／SHM 句柄。

`message` 的内部id与来源出现键、服务端别名、续读cursor各自独立。来源出现键包含来源代次、分片、表实例及精确十进制localId；serverId为0不建立别名。只有支持档明确 `serverAliasSemantics=verified_within_scope` 时才使用服务端别名连接不同本地身份；未知或不支持时保留观测值而不凭正文、时间或相同serverId猜测合并。message_alias使用内部id作为清理主键，完整scope+scheme+external_key仍有唯一约束，长复合出现键不会挤入删除目标键。`capture_record` 直接引用实际规范消息。按 [ADR-128](../../../../architecture/adr/128-deduplicated-wechat-message-storage.md)，重复读取命中仍有效的相同消息来源时复用来源，不再每次新增捕获；正常文字仅在消息层保存正文，来源记录保留定位与必要元数据。版本22迁移仅移除与消息正文完全一致的旧来源正文副本，不一致的历史内容保留；原执行的来源身份不因重复读取改写。非文字正文始终NULL，不下载媒体或调用模型。

服务读取提供 `HistoryRead`，含消息、实际来源record及覆盖；按 [ADR-131](../../../../architecture/adr/131-available-context-without-history-wait.md)，已确认联系人可使用当前有效资料生成，`running/not_started/incomplete` 不阻止生成，也不要求额外确认。读取合同不再返回由覆盖状态派生、没有生成消费者的 `replyEligibility`／`reply_eligibility`；受理时仍冻结实际覆盖与限制，未完成不能标为完整，后续同步不改写原请求依据。已保存请求中的旧确认字段仅供历史回看，不伪造用户确认或扩大读取授权。未知顺序只提供稳定展示，不代表真实先后。后续派生域必须以完整 `(owner_id,contact_id,record_id,message_id)` FK 引用实际来源，不能从当前来源替换过去执行输入。

聊天管理分页只开放 `GET /api/contacts/:contactId/history-messages`，复用 `readChat` 的消息时间排序与图片状态投影；没有产品调用者的旧 `GET .../messages` 路由退役。内部资料读取、覆盖查询、同步及 `.../messages/:messageId/media` 媒体操作保持各自合同，消息分页不会读取外部聊天正文。

迁移由 `historyMigration(version)` 生成，版本仅由公共registry串行决定。本领域删除注册导出 `historyDeletionDomain`；`source(contactId,recordId)` 返回原捕获的不可变实际来源及当时支持档，隔离记录不从此入口提供给派生服务。`capture_record.availability` 在删除fence时立即失效；`source.ts` 的 `assertSourceEligibility(tx,MessageSourceReference)` 要在派生写者自己的接受事务复验，配合其运行/联系人代次，不能只检查先前读到的sourceRecordIds。

写者接受页时复验联系人 `assertReadEligibility`、固定goal、游标及数据代次。本模块没有库外文件；其他媒体、追踪和运行时消费者仍须各自注册，显式requiredDomains缺失不能完成删除。源删除的sourceId指capture_record.id；删除单个来源时保留其他合法来源支持的消息，最后来源删除才清除消息与别名；同一出现键持久抑制，不能因重读复活。清空全部聊天的精确渠道截断由同步快照与删除接线提供，缺失时scope_suppression保持blocked并关闭后续读取，不能宣称清空完整。

宿主在关闭同步、撤销及退出时调用 `stop/close` 并等待释放，不能只停止后续调度。

宿主必须给 `SqliteHistoryService` 与 `DeletionService` 传同一个 `ActiveHolders`，来源目标携带实际读取goal的holderKeys。关闭/删除等待查询终结及finally释放；忽略取消的渠道会使删除超时受阻，不能仅abort后completed。

渠道资格由运行时匹配的工具、支持档、来源身份和读取守卫共同决定；制品证据不能自动替代当前运行时核验。

后台调度的首次历史及其恢复统一由 `FirstHistoryCoordinator` 执行；`IncrementalHistoryCoordinator` 只消费已保存的增量检查点。历史尚不可接续时，增量协调器经 `requestFirstHistoryRecovery` 复验持久资格并请求定点唤醒，不自行发起首次历史。宿主与测试均使用这条接线，不提供增量兼任首次历史的配置；显式 `history/sync` 操作仍复用同一历史服务。两个协调器保留不同调度职责：首次历史负责分片轮转与失败退避，增量负责变化页、空目标低频重探及后续恢复交接。

`FirstHistoryCoordinator` 是首次历史的唤醒层，依赖受控 `directory` 与正式 `SqliteHistoryService`。`wake()` 后台合并请求，最多两位联系人任务并发；实际微信 CLI 操作仍经宿主共享串行入口；只处理有效授权下尚未完整的首次覆盖，不做持续增量、轮询、记忆或媒体。`stop(contactId?)`、`close()` 等待真实渠道返回及关闭；`getState()` 只返回固定状态和脱敏错误，`waitForIdle()` 供诊断及验收。正式宿主在成功启动并发布握手后、逐人确认成功及开启读取后唤醒；确认 HTTP 不等待整批历史。全局关闭同时停止首次历史和微信媒体读取，保留合法本地转换；撤销按联系人停止全部读取。退出先排空协调器，再沿共享领域关闭合同处理消费者、模型与SQLite；失败保留共享资源供原操作重试。

首次历史每位联系人只登记当前已尝试的稳定授权身份；明确全局或定点唤醒直接重置对应记录，不另存取消身份或延迟重置状态。逐人错误随当前调度结果保存，全局展示即时汇总；目录与停读错误另按操作结果维护。成功目录复验后，先等待失效范围的在途取消结束，再撤下已失授权联系人的状态，迟到结果不能恢复旧状态。

`suppression.ts` 直接拥有历史、增量、引用补齐与来源恢复共用的清空屏障校验，调用方只提供读取资格，不区分读取用途；已核验边界还须匹配本人、会话、清空代次和来源代次。`clear-actions.ts` 负责清空边界的持久化与接受，不再为读取校验提供转发入口。

重开先核对元数据与有界锚点，再优先复用有效持久游标；没有可用游标时按每表已存最大 localId 续接，由正式读取器签发恢复证明。真实来源变化或能力不足保存实际不完整及失败原因，不清零为完整。首次派发的合成测试与实际 App／真实渠道验收分别记录。来源删除的 `coversAllSources` 只给可能持有该联系人任意来源的早期历史读者声明；按旧数据代次排空，不从已有 goal 猜测当前内存读者。

开发窄客户端另有 `observeTestMetadataSelected('arm'|'next'|'current')`：一次基线、逐阶段唯一 owner/text 新行、最多两条，复查只用内部已锁主键。错误终止观察并排空，不重试改变时序关联；未知状态不放行正常历史。真实 UI 发送成功不能代替状态语义认证。

`createWechatHistoryChannel(executable?)` 使用显式工具路径及固定旁侧 manifest，经正式窄客户端核验制品和支持档。实例绑定账号、稳定会话键及完整读取 token；任一范围字段变化关闭读者。未配置或支持未认证时拒绝正文，不自动寻找工具。原生 target 属于固定快照；只有读取器声明并核验的持久 cursor 才能跨快照复用，恢复 cursor 也必须由读取器签发，业务层不拼接。公共宿主须传入受控配置路径；真实支持状态仍按运行时报告。

联系人窄元数据与正文资格分开：工具配置账号按固定版本／完整 contact、SessionTable 结构／可读性及前后配置和来源守卫核验，账号 generation 与稳定私聊 resolve 共用来源公式。名单只在服务明确同意后读取必要私聊字段；未知支持、重复或缺失拒绝。metadata verified 不授权正文，也不表示前台登录核验。端口失败排空旧客户端，后续显式重检可重新核验，不能恢复旧授权。

阶段实现和旧验收记录已移至[开发历史](../../../../docs/history/backend-development-history.md)；历史数字不表示当前版本通过。
